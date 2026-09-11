-- =====================================================================
-- Bluesky follow campaigns — provider intent, lock order, exact folding
-- =====================================================================
--
-- A THIRD forward-only migration. 20260911000003 and 20260911000004 are
-- merged and may already be applied, so neither is touched. Everything
-- here is additive, idempotent, and assumes both have run.
--
-- Three defects, each reproduced against a real PostgreSQL server
-- before it was fixed.
--
-- 1. A CRASH BEFORE ANYTHING WAS SENT PERMANENTLY SILENCED A MEMBER.
--
--    `claim_bluesky_campaign_action` stamped `provider_in_flight_at` at
--    the moment the audit row was created — before the quota call,
--    before the session, before any request existed. If the worker then
--    died, or the quota call failed, the marker said "a mutation may be
--    in flight" about a mutation that had never been attempted.
--
--    Every later pass read that marker, entered reconciliation-only
--    mode, and refused to send. The profile was never followed at all,
--    silently, for the life of the campaign. Zero createRecord calls,
--    forever, for a member whose first attempt had not yet happened.
--
--    The marker now goes up in the SAME transaction that spends the
--    quota unit, immediately before the provider call — so it means
--    what it says.
--
-- 2. THE QUOTA FUNCTIONS COULD DEADLOCK EACH OTHER.
--
--    `reserve` and `apply_bluesky_run_outcome` locked identity usage
--    first and the reservation later. `consume` locked the reservation
--    first and identity usage later. Two backends doing ordinary work
--    on the same identity formed a cycle, and PostgreSQL killed one of
--    them with "deadlock detected" — reproduced, not theorised.
--
--    One global order now applies everywhere:
--
--        identity usage → run → reservation → ledger → action
--
--    Re-acquiring a lock already held is free, so functions that call
--    each other stay consistent by construction.
--
-- 3. FOLDING READ THE WRONG ACTION.
--
--    `fold_bluesky_ledger_outcomes` joined actions on `member_id`
--    alone. A member may legitimately have more than one action row —
--    the unique index only forbids a second NON-skipped one — so an
--    earlier skipped attempt plus a later successful one matched twice.
--    One attempt then produced two outcomes, and which one won was
--    whatever the planner picked: the measured result recorded the
--    SKIP and dropped the success.
--
--    The ledger already records which action it paid for. It is now
--    joined by that id.

-- =====================================================================
-- 1. Claiming an audit row is not a provider mutation
-- =====================================================================
--
-- Creating the row says "this worker intends to handle this member".
-- It does not say "a request is in flight", and conflating the two is
-- what silenced members that had never been touched.
--
-- `needs_reconcile` is likewise decided by the MARKER rather than by
-- the status. A row sitting at `running` because a previous worker
-- claimed it and died before spending its unit has nothing to
-- reconcile — nothing was sent.

create or replace function public.claim_bluesky_campaign_action(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_member_id uuid,
  p_operator_account_id uuid,
  p_subject_did text,
  p_subject_handle text,
  p_actor_did text,
  p_actor_handle text,
  p_initiated_by uuid
)
returns table (
  action_id uuid,
  may_mutate boolean,
  needs_reconcile boolean,
  terminal boolean,
  existing_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.bluesky_relationship_actions;
  v_id uuid;
begin
  select * into v_existing
    from public.bluesky_relationship_actions
   where campaign_id = p_campaign_id
     and campaign_member_id = p_member_id
     and status <> 'skipped'
   for update;

  if v_existing.id is not null then
    action_id := v_existing.id;
    existing_status := v_existing.status;

    if v_existing.status in ('succeeded', 'failed', 'reconciliation_required') then
      may_mutate := false; needs_reconcile := false; terminal := true;
      return next; return;
    end if;

    -- The MARKER decides, not the status.
    --
    -- With the marker set, a createRecord may already have reached a
    -- real person: reconciliation only. Without it, nothing was ever
    -- sent — a worker claimed this row and died before spending its
    -- unit — and the member is still owed its first attempt.
    if v_existing.provider_in_flight_at is not null then
      may_mutate := false;
      needs_reconcile := true;
    else
      may_mutate := true;
      needs_reconcile := false;
    end if;
    terminal := false;

    update public.bluesky_relationship_actions
       set status = 'running',
           started_at = coalesce(started_at, now()),
           campaign_run_id = coalesce(campaign_run_id, p_run_id)
     where id = v_existing.id;
    return next; return;
  end if;

  -- A fresh row. No in-flight marker: nothing has been sent yet, and
  -- saying otherwise is what caused defect 1.
  insert into public.bluesky_relationship_actions (
    workspace_id, operator_account_id, candidate_id, batch_id,
    action_type, subject_did, subject_handle_at_action,
    actor_did, actor_handle_at_action, status,
    source_target_profile_ids, initiated_by, initiator_kind,
    campaign_id, campaign_run_id, campaign_member_id,
    provider_in_flight_at, started_at
  )
  values (
    p_workspace_id, p_operator_account_id, null, null,
    'follow', p_subject_did, p_subject_handle,
    p_actor_did, p_actor_handle, 'running',
    '{}', p_initiated_by, 'operator_batch',
    p_campaign_id, p_run_id, p_member_id,
    null, now()
  )
  returning id into v_id;

  action_id := v_id;
  may_mutate := true;
  needs_reconcile := false;
  terminal := false;
  existing_status := null;
  return next;
exception
  when unique_violation then
    -- Lost the race to another worker between the select and the
    -- insert. Fall back to whatever it created.
    select * into v_existing
      from public.bluesky_relationship_actions
     where campaign_id = p_campaign_id
       and campaign_member_id = p_member_id
       and status <> 'skipped';
    action_id := v_existing.id;
    existing_status := v_existing.status;
    terminal := v_existing.status in
      ('succeeded', 'failed', 'reconciliation_required');
    needs_reconcile :=
      not terminal and v_existing.provider_in_flight_at is not null;
    may_mutate := false;
    return next;
end;
$$;

comment on function public.claim_bluesky_campaign_action is
  'Create or take over the durable audit row for one campaign member. '
  'Does NOT mark a provider mutation in flight — that happens in '
  'consume_bluesky_member_quota, in the same transaction that spends '
  'the quota unit, immediately before the request.';

revoke all on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  to service_role;

-- =====================================================================
-- 2. The ledger's ownership is fixed once intent is stamped
-- =====================================================================
--
-- A ledger row with intent is the record of a public act. Which
-- reservation paid for it, which member it was, and WHICH ACTION it
-- refers to are all part of that record — `action_id` especially, now
-- that folding reads the outcome through it. A row whose action_id
-- could be repointed afterwards would let the outcome be rewritten.

create or replace function public.bluesky_attempt_ledger_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if old.provider_intent_at is not null
     and new.provider_intent_at is distinct from old.provider_intent_at then
    raise exception
      'bluesky_campaign_attempt_ledger.provider_intent_at is immutable';
  end if;
  if old.counted_at is not null
     and new.counted_at is distinct from old.counted_at then
    raise exception
      'bluesky_campaign_attempt_ledger.counted_at is immutable once set';
  end if;

  -- Identity columns never change, intent or not.
  if new.reservation_id is distinct from old.reservation_id
     or new.member_id is distinct from old.member_id
     or new.run_id is distinct from old.run_id
     or new.workspace_id is distinct from old.workspace_id
     or new.campaign_id is distinct from old.campaign_id
     or new.operator_account_id is distinct from old.operator_account_id
     or new.usage_date is distinct from old.usage_date then
    raise exception
      'bluesky_campaign_attempt_ledger ownership columns are immutable';
  end if;

  -- `action_id` may still be filled in while no attempt has been made;
  -- once intent exists it names the action whose outcome will be
  -- folded, and repointing it would rewrite history.
  if old.provider_intent_at is not null
     and new.action_id is distinct from old.action_id then
    raise exception
      'bluesky_campaign_attempt_ledger.action_id is immutable after provider intent';
  end if;

  return new;
end;
$$;

-- =====================================================================
-- 3. Spending a unit: one order, full ownership, both markers
-- =====================================================================
--
-- LOCK ORDER, everywhere in this subsystem:
--
--     identity usage → run → reservation → ledger → action
--
-- Validation is the whole tuple, because each part names a different
-- budget or a different tenant: a reservation from another workspace,
-- campaign, run, identity or day is not this attempt's to spend, and an
-- action belonging to another member is not this attempt's to mark.
--
-- Everything below happens in ONE transaction, so:
--   • a failure BEFORE it commits leaves no intent and no marker, and
--     the member is safe to retry from scratch;
--   • a failure AFTER it commits leaves both, and the member is
--     reconciliation-only until Bluesky says otherwise.
-- There is no state in between.

create or replace function public.consume_bluesky_member_quota(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_member_id uuid,
  p_action_id uuid,
  p_operator_account_id uuid
)
returns table (
  consumed boolean,
  already_consumed boolean,
  refused_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.bluesky_identity_daily_usage;
  v_run public.bluesky_follow_campaign_runs;
  v_res public.bluesky_campaign_quota_reservations;
  v_ledger public.bluesky_campaign_attempt_ledger;
  v_action public.bluesky_relationship_actions;
  v_member public.bluesky_follow_campaign_members;
  v_usage_date date;
begin
  -- The run names the day, so it is read (unlocked) first to find the
  -- usage row that must be locked FIRST.
  select * into v_run
    from public.bluesky_follow_campaign_runs
   where id = p_run_id
     and workspace_id = p_workspace_id
     and campaign_id = p_campaign_id;
  if v_run.id is null then
    consumed := false; already_consumed := false;
    refused_reason := 'unknown_run'; return next; return;
  end if;

  select usage_date into v_usage_date
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id;
  if v_usage_date is null then
    consumed := false; already_consumed := false;
    refused_reason := 'unknown_reservation'; return next; return;
  end if;

  -- ── 1. identity usage ──
  insert into public.bluesky_identity_daily_usage (
    workspace_id, operator_account_id, usage_date
  )
  values (p_workspace_id, p_operator_account_id, v_usage_date)
  on conflict (workspace_id, operator_account_id, usage_date) do nothing;

  select * into v_usage
    from public.bluesky_identity_daily_usage
   where workspace_id = p_workspace_id
     and operator_account_id = p_operator_account_id
     and usage_date = v_usage_date
     for update;

  -- ── 2. run ──
  select * into v_run
    from public.bluesky_follow_campaign_runs
   where id = p_run_id for update;

  -- ── 3. reservation ──
  select * into v_res
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id for update;

  if v_res.id is null then
    consumed := false; already_consumed := false;
    refused_reason := 'unknown_reservation'; return next; return;
  elsif v_res.workspace_id <> p_workspace_id then
    consumed := false; already_consumed := false;
    refused_reason := 'workspace_mismatch'; return next; return;
  elsif v_res.campaign_id <> p_campaign_id then
    consumed := false; already_consumed := false;
    refused_reason := 'campaign_mismatch'; return next; return;
  elsif v_res.run_id <> p_run_id then
    consumed := false; already_consumed := false;
    refused_reason := 'run_mismatch'; return next; return;
  elsif v_res.operator_account_id <> p_operator_account_id then
    consumed := false; already_consumed := false;
    refused_reason := 'identity_mismatch'; return next; return;
  elsif v_res.status <> 'open' then
    -- A settled or expired reservation cannot fund anything. Without
    -- this a worker resuming after a sweep would spend quota that has
    -- already been accounted for and returned.
    consumed := false; already_consumed := false;
    refused_reason := 'reservation_' || v_res.status; return next; return;
  end if;

  -- The member must belong to this campaign.
  select * into v_member
    from public.bluesky_follow_campaign_members
   where id = p_member_id
     and workspace_id = p_workspace_id
     and campaign_id = p_campaign_id;
  if v_member.id is null then
    consumed := false; already_consumed := false;
    refused_reason := 'member_mismatch'; return next; return;
  end if;

  -- ── 4. ledger ──
  select * into v_ledger
    from public.bluesky_campaign_attempt_ledger
   where reservation_id = p_reservation_id
     and member_id = p_member_id
     for update;

  if v_ledger.id is not null and v_ledger.provider_intent_at is not null then
    -- Already spent. A retry after a lost response, and the unit is
    -- paid for.
    consumed := false; already_consumed := true;
    refused_reason := null; return next; return;
  end if;

  if v_res.reserved_count <= 0 then
    consumed := false; already_consumed := false;
    refused_reason := 'reservation_exhausted'; return next; return;
  end if;

  -- ── 5. action ──
  select * into v_action
    from public.bluesky_relationship_actions
   where id = p_action_id for update;

  if v_action.id is null then
    consumed := false; already_consumed := false;
    refused_reason := 'unknown_action'; return next; return;
  elsif v_action.workspace_id <> p_workspace_id
     or v_action.campaign_id is distinct from p_campaign_id
     or v_action.campaign_member_id is distinct from p_member_id then
    consumed := false; already_consumed := false;
    refused_reason := 'action_mismatch'; return next; return;
  elsif v_action.status in ('succeeded', 'failed', 'reconciliation_required') then
    consumed := false; already_consumed := false;
    refused_reason := 'action_terminal'; return next; return;
  end if;

  -- Everything below commits together or not at all.
  if v_ledger.id is null then
    insert into public.bluesky_campaign_attempt_ledger (
      workspace_id, campaign_id, run_id, operator_account_id, usage_date,
      reservation_id, member_id, action_id, provider_intent_at
    )
    values (
      v_res.workspace_id, v_res.campaign_id, v_res.run_id,
      v_res.operator_account_id, v_res.usage_date,
      p_reservation_id, p_member_id, p_action_id, now()
    );
  else
    update public.bluesky_campaign_attempt_ledger
       set action_id = p_action_id,
           provider_intent_at = now()
     where id = v_ledger.id;
  end if;

  -- The marker goes up HERE, one statement before the request, so it
  -- can never describe a mutation that was not attempted.
  update public.bluesky_relationship_actions
     set provider_in_flight_at = now(),
         started_at = coalesce(started_at, now()),
         campaign_run_id = coalesce(campaign_run_id, p_run_id)
   where id = p_action_id;

  update public.bluesky_campaign_quota_reservations
     set reserved_count = reserved_count - 1
   where id = p_reservation_id;

  update public.bluesky_follow_campaign_runs
     set attempted_count = attempted_count + 1,
         reserved_count = greatest(reserved_count - 1, 0)
   where id = v_res.run_id;

  update public.bluesky_identity_daily_usage
     set attempts_made = attempts_made + 1,
         reserved_count = greatest(reserved_count - 1, 0),
         updated_at = now()
   where id = v_usage.id;

  consumed := true; already_consumed := false; refused_reason := null;
  return next;
end;
$$;

-- The unordered predecessor must not remain callable: it is the
-- deadlock.
drop function if exists public.consume_bluesky_member_quota(uuid, uuid, uuid, uuid);

revoke all on function public.consume_bluesky_member_quota(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.consume_bluesky_member_quota(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  to service_role;

-- =====================================================================
-- 4. Folding the EXACT action the ledger paid for
-- =====================================================================
--
-- The join is by `ledger.action_id`. The legacy fallback — for rows
-- written before the id was recorded — is a LATERAL with an explicit
-- total order and `limit 1`, so it resolves to exactly one action or to
-- none, and can never fan a ledger row out into two outcomes.
--
-- Its order is deterministic and stated: a real attempt outranks a
-- skip, then the most recent, then the id as a final tiebreak.

create or replace function public.fold_bluesky_ledger_outcomes(
  p_reservation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_usage_id uuid;
  v_succeeded integer := 0;
  v_already integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_records integer := 0;
  v_folded integer := 0;
begin
  select r.run_id, u.id into v_run_id, v_usage_id
    from public.bluesky_campaign_quota_reservations r
    left join public.bluesky_identity_daily_usage u
      on u.workspace_id = r.workspace_id
     and u.operator_account_id = r.operator_account_id
     and u.usage_date = r.usage_date
   where r.id = p_reservation_id;

  if v_run_id is null then
    return 0;
  end if;

  -- Same global order as everything else: usage, then run, then the
  -- ledger rows. Re-acquiring a lock a caller already holds is free.
  if v_usage_id is not null then
    perform 1 from public.bluesky_identity_daily_usage
      where id = v_usage_id for update;
  end if;
  perform 1 from public.bluesky_follow_campaign_runs
    where id = v_run_id for update;

  with pending as (
    select l.id, l.member_id, l.campaign_id, l.action_id
      from public.bluesky_campaign_attempt_ledger l
     where l.reservation_id = p_reservation_id
       and l.counted_at is null
       for update
  ),
  resolved as (
    select p.id,
           coalesce(named.status, legacy.status) as action_status,
           coalesce(named.follow_uri, legacy.follow_uri) as follow_uri
      from pending p
      -- The action this attempt actually paid for.
      left join public.bluesky_relationship_actions named
        on named.id = p.action_id
      -- Legacy rows only, and at most ONE of them.
      left join lateral (
        select a.status, a.follow_uri
          from public.bluesky_relationship_actions a
         where p.action_id is null
           and a.campaign_member_id = p.member_id
           and a.campaign_id = p.campaign_id
         order by (a.status <> 'skipped') desc, a.created_at desc, a.id
         limit 1
      ) legacy on true
  ),
  classified as (
    select id,
           case
             -- A succeeded action WITHOUT a follow record is the
             -- already-following path: observed, not created, and no
             -- provider budget was spent.
             when action_status = 'succeeded' and follow_uri is not null
               then 'succeeded'
             when action_status = 'succeeded' then 'already_following'
             when action_status = 'failed' then 'failed'
             when action_status = 'skipped' then 'skipped'
             -- reconciliation_required, still running, or no action at
             -- all. UNKNOWN: counted as no outcome, but its unit was
             -- spent at provider intent and is never returned.
             else 'unknown'
           end as outcome
      from resolved
  ),
  counted as (
    update public.bluesky_campaign_attempt_ledger l
       set counted_at = now()
      from classified c
     where l.id = c.id
     returning c.outcome
  )
  select
    count(*) filter (where outcome = 'succeeded')::int,
    count(*) filter (where outcome = 'already_following')::int,
    count(*) filter (where outcome = 'failed')::int,
    count(*) filter (where outcome = 'skipped')::int,
    count(*) filter (where outcome = 'succeeded')::int,
    count(*)::int
  into v_succeeded, v_already, v_failed, v_skipped, v_records, v_folded
  from counted;

  if v_folded = 0 then
    return 0;
  end if;

  -- `attempted_count` is NOT touched here. It was incremented at
  -- provider intent, one member at a time, which is why attempts
  -- survive a crash.
  update public.bluesky_follow_campaign_runs
     set succeeded_count = succeeded_count + v_succeeded,
         already_following_count = already_following_count + v_already,
         failed_count = failed_count + v_failed,
         skipped_count = skipped_count + v_skipped,
         last_chunk_at = now()
   where id = v_run_id;

  if v_usage_id is not null then
    update public.bluesky_identity_daily_usage
       set follows_created = follows_created + v_records,
           updated_at = now()
     where id = v_usage_id;
  end if;

  return v_folded;
end;
$$;

revoke all on function public.fold_bluesky_ledger_outcomes(uuid)
  from public, anon, authenticated;
grant execute on function public.fold_bluesky_ledger_outcomes(uuid)
  to service_role;

-- =====================================================================
-- 5. The sweep takes the same order
-- =====================================================================
--
-- Reached from `reserve`, which already holds identity usage, but it is
-- callable on its own. Taking the usage row first makes it safe either
-- way instead of safe only by context.

create or replace function public.sweep_bluesky_quota_reservations(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_usage_date date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_swept integer := 0;
begin
  perform 1
     from public.bluesky_identity_daily_usage
    where workspace_id = p_workspace_id
      and operator_account_id = p_operator_account_id
      and usage_date = p_usage_date
      for update;

  for v_id in
    select r.id
      from public.bluesky_campaign_quota_reservations r
     where r.workspace_id = p_workspace_id
       and r.operator_account_id = p_operator_account_id
       and r.usage_date = p_usage_date
       and r.status = 'open'
       and r.expires_at < now()
     order by r.created_at, r.id
     for update skip locked
  loop
    perform public.fold_bluesky_ledger_outcomes(v_id);
    update public.bluesky_campaign_quota_reservations
       set status = 'expired', reserved_count = 0
     where id = v_id;
    v_swept := v_swept + 1;
  end loop;

  return v_swept;
end;
$$;

revoke all on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  to service_role;
