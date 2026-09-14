-- Bluesky campaigns — run recovery, rejected-vs-ambiguous, conservation.
--
-- Forward-only. Every earlier migration remains byte-identical.
--
-- PRODUCTION INCIDENT, 2026-09-14 (campaign "WebmasterID 1-3")
-- --------------------------------------------------------------
-- The first createRecord of every day carries an access token that
-- expired overnight. Bluesky answers HTTP 400 {"error":"ExpiredToken"}.
-- Three defects turned that routine event into two lost days:
--
--   1. An auth stop marked the RUN `failed`. Nothing resumes a failed
--      run — `resume_bluesky_campaign_run` moves only `rate_limited`
--      runs, and the dispatcher returns on any status but `running` —
--      so after the operator reconnected and resumed the CAMPAIGN,
--      every tick for the rest of the day did nothing, and the
--      out-of-window tick moved next_run_at to tomorrow. 22,058 of
--      22,341 members waited while 339 of 400 units went unused.
--
--   2. A definitive provider REJECTION after provider intent was filed
--      as `reconciliation_required`. Reconciliation reads relationship
--      truth; for a request the provider refused before writing, truth
--      is `not_following` forever. The member cycled every ten minutes
--      as "may have reached Bluesky — not re-sent", never received a
--      real retry, and never resolved.
--
--   3. (Application-side, fixed in TypeScript) the refreshed session
--      was not carried across chunks, so each chunk re-rotated the
--      single-use refresh token from the original expired session.
--
-- WHAT THIS MIGRATION CHANGES
-- ---------------------------
--   A. `reserve_bluesky_campaign_quota` — the reconciliation takeover
--      no longer claims a RE-OPENED action (pending, no in-flight
--      marker). Reproduced from the INSTALLED definition, including
--      the pg-safeupdate `where true` guards that 20260912000003
--      patched in place; the only change is the takeover predicate.
--   B. `fold_bluesky_ledger_outcomes` — an intent superseded by a later
--      intent for the same member folds as no outcome, so a rejected-
--      then-retried follow is counted once. Reproduced from the
--      installed definition; the only change is the `superseded` case.
--   C. `reopen_bluesky_campaign_action` — returns a rejected-before-
--      write action to `pending` with its marker cleared, guarded.
--   D. `resume_bluesky_campaign_run_after_recovery` — returns today's
--      run to `running` from a RECOVERABLE stop only; never from an
--      operator pause, which lives on the campaign.
--   E. `bluesky_campaign_conservation` / `bluesky_campaign_may_complete`
--      — the conservation equation, computed by the database.
--   F. `bluesky_follow_campaign_members.reconcile_count` — the slow
--      lane's counter, so an ambiguity is visible and bounded.
--
-- Deploy order: this migration BEFORE the application. The new RPCs
-- are additive; the changed ones are call-compatible with the deployed
-- worker, which simply never re-opens an action.

set search_path = public;

-- =====================================================================
-- F. The slow lane's counter
-- =====================================================================

alter table public.bluesky_follow_campaign_members
  add column if not exists reconcile_count integer not null default 0;

comment on column public.bluesky_follow_campaign_members.reconcile_count is
  'Reconciliation reads performed for this member. After the first '
  'twelve (two hours at ten-minute spacing) the backoff widens to six '
  'hours: still visible, still retried, never terminal, never tight.';

-- =====================================================================
-- A. The takeover predicate
-- =====================================================================

CREATE OR REPLACE FUNCTION public.reserve_bluesky_campaign_quota(p_workspace_id uuid, p_campaign_id uuid, p_run_id uuid, p_operator_account_id uuid, p_usage_date date, p_requested integer, p_identity_ceiling integer, p_chunk_size integer, p_lease_seconds integer, p_claimed_by text)
 RETURNS TABLE(reserved integer, reservation_id uuid, reason text, member_id uuid, subject_did text, current_handle text, import_sequence bigint, attempt_count integer, provider_record_rkey text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.bluesky_follow_campaign_runs;
  v_usage public.bluesky_identity_daily_usage;
  v_run_reserved integer;
  v_identity_reserved integer;
  v_run_headroom integer;
  v_identity_headroom integer;
  v_grant integer;
  v_actual integer;
  v_reservation_id uuid;
  v_lease integer;
  v_reason text;
begin
  v_lease := least(greatest(coalesce(p_lease_seconds, 60), 10), 3600);

  -- Fixed lock order: identity first, then run.
  insert into public.bluesky_identity_daily_usage (
    workspace_id, operator_account_id, usage_date
  )
  values (p_workspace_id, p_operator_account_id, p_usage_date)
  on conflict (workspace_id, operator_account_id, usage_date) do nothing;

  select * into v_usage
    from public.bluesky_identity_daily_usage
   where workspace_id = p_workspace_id
     and operator_account_id = p_operator_account_id
     and usage_date = p_usage_date
     for update;

  select * into v_run
    from public.bluesky_follow_campaign_runs
   where id = p_run_id
     and workspace_id = p_workspace_id
     and campaign_id = p_campaign_id
     for update;

  if v_run.id is null then
    reserved := 0; reason := 'run_missing'; return next; return;
  end if;

  -- A run that is not running reserves nothing. Checked under the lock
  -- so a pause landing mid-reservation is honoured.
  if v_run.status <> 'running' then
    reserved := 0; reason := 'run_not_running'; return next; return;
  end if;

  perform public.sweep_bluesky_quota_reservations(
    p_workspace_id, p_operator_account_id, p_usage_date);

  -- RECONCILIATION TAKEOVER, before any quota arithmetic.
  --
  -- A member whose action is unresolved has ALREADY spent its unit —
  -- `provider_intent_at` is stamped and the unit came off its
  -- reservation at that moment. Reconciling it reads relationship truth
  -- and can never send a mutation, so it costs nothing more and must
  -- not have to compete for headroom.
  --
  -- Requiring headroom here deadlocks exactly when it matters most: a
  -- campaign that has spent its whole quota has none left, so it could
  -- never claim the member whose outcome is still unknown, and that
  -- member would sit unresolved forever.
  --
  -- These members are handed a ZERO-unit reservation. It is a real
  -- reservation — it owns the settlement, carries the ledger rows and
  -- is swept like any other — it simply promises no new quota.
  create temp table if not exists _claimed_members (
    id uuid, subject_did text, current_handle text,
    import_sequence bigint, attempt_count integer, provider_record_rkey text
  ) on commit drop;
  delete from _claimed_members where true;

  with picked as (
    select c.id
      from public.bluesky_follow_campaign_members c
     where c.workspace_id = p_workspace_id
       and c.campaign_id = p_campaign_id
       -- Whatever state the member is IN. A worker that reconciles
       -- without learning anything persists it as `retryable`, and
       -- matching only leased rows meant such a member could never be
       -- picked up again: the takeover skipped it, and the ordinary
       -- path wanted quota it does not need.
       and (
         (c.status in ('claimed', 'running')
            and c.lease_expires_at is not null
            and c.lease_expires_at < now())
         or (c.status in ('queued', 'retryable')
            and (c.next_attempt_at is null or c.next_attempt_at <= now()))
       )
       -- Already paid: the unit left its reservation at provider intent.
       and exists (
         select 1
           from public.bluesky_campaign_attempt_ledger l
          where l.member_id = c.id
            and l.provider_intent_at is not null
       )
       -- And still unresolved IN A WAY ONLY A READ CAN RESOLVE.
       --
       -- Two shapes qualify:
       --   • `reconciliation_required` — a previous pass read truth and
       --     could not conclude; keep reading.
       --   • an in-flight marker still up — a worker died between
       --     sending and settling; the outcome is genuinely unknown.
       --
       -- A `pending` action with NO marker does not qualify, even
       -- though a ledger intent exists for the member. That is a
       -- RE-OPENED action: the provider REJECTED the earlier request
       -- before writing anything (HTTP 400 ExpiredToken, 429), so
       -- there is nothing to reconcile and the member is owed a real
       -- retry through the ordinary quota path. Taking it over here
       -- handed it a zero-unit reservation, `consume` refused to fund
       -- it, and it cycled every backoff forever as "may have reached
       -- Bluesky" — for a request Bluesky had told us it refused.
       and exists (
         select 1
           from public.bluesky_relationship_actions a
          where a.campaign_member_id = c.id
            and (
              a.status = 'reconciliation_required'
              or (a.status in ('pending', 'running')
                  and a.provider_in_flight_at is not null)
            )
       )
     order by c.import_sequence
     for update skip locked
     limit least(greatest(coalesce(p_chunk_size, 1), 1), 100)
  )
  insert into _claimed_members
  select m.id, m.subject_did, m.current_handle, m.import_sequence,
         m.attempt_count, m.provider_record_rkey
    from public.bluesky_follow_campaign_members m
   where m.id in (select id from picked);

  select count(*)::int into v_actual from _claimed_members;

  if v_actual > 0 then
    insert into public.bluesky_campaign_quota_reservations (
      workspace_id, campaign_id, run_id, operator_account_id, usage_date,
      reserved_count, status, claimed_by, expires_at
    )
    values (
      p_workspace_id, p_campaign_id, p_run_id, p_operator_account_id,
      p_usage_date, 0, 'open', p_claimed_by,
      now() + make_interval(secs => v_lease)
    )
    returning id into v_reservation_id;

    update public.bluesky_follow_campaign_members m
       set status = 'claimed',
           claimed_at = now(),
           claimed_by = p_claimed_by,
           reservation_id = v_reservation_id,
           lease_expires_at = now() + make_interval(secs => v_lease)
     where m.id in (select id from _claimed_members);

    -- A ledger row for the new reservation, carrying no intent: this
    -- pass may only read. If it does reach provider intent — it must
    -- not — `consume` would refuse, because a zero-unit reservation has
    -- nothing to spend.
    insert into public.bluesky_campaign_attempt_ledger (
      workspace_id, campaign_id, run_id, operator_account_id, usage_date,
      reservation_id, member_id
    )
    select p_workspace_id, p_campaign_id, p_run_id, p_operator_account_id,
           p_usage_date, v_reservation_id, c.id
      from _claimed_members c
    on conflict on constraint bluesky_attempt_ledger_once do nothing;

    return query
    select 0, v_reservation_id, 'reconcile'::text, c.id, c.subject_did,
           c.current_handle, c.import_sequence, c.attempt_count,
           c.provider_record_rkey
      from _claimed_members c
     order by c.import_sequence;
    return;
  end if;

  -- Outstanding quota, read from the reservations that OWN it. Both
  -- scopes matter: the run bounds this campaign's day, the identity
  -- bounds the Bluesky account across every campaign driving it.
  select coalesce(sum(reserved_count), 0)::int into v_run_reserved
    from public.bluesky_campaign_quota_reservations
   where run_id = p_run_id and status in ('open', 'held');

  select coalesce(sum(reserved_count), 0)::int into v_identity_reserved
    from public.bluesky_campaign_quota_reservations
   where workspace_id = p_workspace_id
     and operator_account_id = p_operator_account_id
     and usage_date = p_usage_date
     and status in ('open', 'held');

  -- `attempted_count` is now exactly the number of units DURABLY
  -- consumed: incremented at provider intent, one member at a time, and
  -- never batched. So headroom is the plain subtraction, with no
  -- correction terms.
  --
  -- It used to be adjusted by `skipped_count`, because attempts were
  -- reported in bulk at settlement and a dry run or an ineligible
  -- account counted among them. Neither reaches provider intent now, so
  -- neither is in `attempted_count`, and subtracting skips would credit
  -- back quota that was never taken.
  v_run_headroom := greatest(
    0,
    v_run.effective_daily_quota - v_run.attempted_count - v_run_reserved
  );

  -- The identity is bounded by ATTEMPTS, not by records created. A
  -- follow that failed still cost provider budget, and an attempt whose
  -- outcome was never learned cost it too.
  v_identity_headroom := greatest(
    0,
    coalesce(p_identity_ceiling, 0)
      - greatest(v_usage.attempts_made, v_usage.follows_created)
      - v_identity_reserved
  );

  v_grant := least(
    greatest(coalesce(p_requested, 0), 0),
    v_run_headroom,
    v_identity_headroom,
    least(greatest(coalesce(p_chunk_size, 1), 1), 100)
  );

  if v_grant <= 0 then
    -- Say WHICH limit bound, so the caller can act correctly.
    if v_run_headroom <= 0 then
      v_reason := 'quota_exhausted';
    elsif v_identity_headroom <= 0 then
      v_reason := 'identity_exhausted';
    else
      v_reason := 'nothing_requested';
    end if;
    update public.bluesky_follow_campaign_runs
       set reserved_count = v_run_reserved where id = p_run_id;
    update public.bluesky_identity_daily_usage
       set reserved_count = v_identity_reserved where id = v_usage.id;
    reserved := 0; reason := v_reason; return next; return;
  end if;

  -- Open the reservation BEFORE claiming, so every claimed member can
  -- name the quota that paid for it.
  insert into public.bluesky_campaign_quota_reservations (
    workspace_id, campaign_id, run_id, operator_account_id, usage_date,
    reserved_count, status, claimed_by, expires_at
  )
  values (
    p_workspace_id, p_campaign_id, p_run_id, p_operator_account_id,
    p_usage_date, v_grant, 'open', p_claimed_by,
    now() + make_interval(secs => v_lease)
  )
  returning id into v_reservation_id;

  create temp table if not exists _claimed_members (
    id uuid, subject_did text, current_handle text,
    import_sequence bigint, attempt_count integer, provider_record_rkey text
  ) on commit drop;
  delete from _claimed_members where true;

  -- Claim exactly the reserved number. SKIP LOCKED keeps two workers
  -- off the same rows; the reservation keeps them off the same quota.
  with picked as (
    select c.id
      from public.bluesky_follow_campaign_members c
     where c.workspace_id = p_workspace_id
       and c.campaign_id = p_campaign_id
       and (
         (c.status in ('queued', 'retryable')
            and (c.next_attempt_at is null or c.next_attempt_at <= now()))
         or (c.status in ('claimed', 'running')
            and c.lease_expires_at is not null
            and c.lease_expires_at < now())
       )
     order by c.import_sequence
     for update skip locked
     limit v_grant
  )
  insert into _claimed_members
  select m.id, m.subject_did, m.current_handle, m.import_sequence,
         m.attempt_count, m.provider_record_rkey
    from public.bluesky_follow_campaign_members m
   where m.id in (select id from picked);

  update public.bluesky_follow_campaign_members m
     set status = 'claimed',
         claimed_at = now(),
         claimed_by = p_claimed_by,
         reservation_id = v_reservation_id,
         lease_expires_at = now() + make_interval(secs => v_lease)
   where m.id in (select id from _claimed_members);

  -- A ledger row per claimed member, with NO intent yet. Intent — and
  -- with it the unit of quota — is stamped only when the worker is
  -- about to call the provider.
  insert into public.bluesky_campaign_attempt_ledger (
    workspace_id, campaign_id, run_id, operator_account_id, usage_date,
    reservation_id, member_id
  )
  select p_workspace_id, p_campaign_id, p_run_id, p_operator_account_id,
         p_usage_date, v_reservation_id, c.id
    from _claimed_members c
  on conflict on constraint bluesky_attempt_ledger_once do nothing;

  select count(*)::int into v_actual from _claimed_members;

  if v_actual <= 0 then
    -- The queue ran out between the headroom computation and the claim.
    -- Holding the reservation would leak quota nothing will release.
    delete from public.bluesky_campaign_quota_reservations
     where id = v_reservation_id;
    update public.bluesky_follow_campaign_runs
       set reserved_count = v_run_reserved where id = p_run_id;
    update public.bluesky_identity_daily_usage
       set reserved_count = v_identity_reserved where id = v_usage.id;
    reserved := 0; reason := 'queue_empty'; return next; return;
  end if;

  -- Reserve only what was actually claimed.
  if v_actual <> v_grant then
    update public.bluesky_campaign_quota_reservations
       set reserved_count = v_actual where id = v_reservation_id;
  end if;

  update public.bluesky_follow_campaign_runs
     set reserved_count = v_run_reserved + v_actual where id = p_run_id;
  update public.bluesky_identity_daily_usage
     set reserved_count = v_identity_reserved + v_actual where id = v_usage.id;

  return query
  select v_actual, v_reservation_id, 'granted'::text, c.id, c.subject_did,
         c.current_handle, c.import_sequence, c.attempt_count,
         c.provider_record_rkey
    from _claimed_members c
   order by c.import_sequence;
end;
$function$;


-- =====================================================================
-- B. Folding: a superseded intent counts nothing
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fold_bluesky_ledger_outcomes(p_reservation_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run_id uuid;
  v_usage_id uuid;
  v_kind text;
  v_succeeded integer := 0;
  v_already integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_unresolved integer := 0;
  v_records integer := 0;
  v_intents integer := 0;
  v_folded integer := 0;
begin
  select r.run_id, u.id, c.kind
    into v_run_id, v_usage_id, v_kind
    from public.bluesky_campaign_quota_reservations r
    left join public.bluesky_identity_daily_usage u
      on u.workspace_id = r.workspace_id
     and u.operator_account_id = r.operator_account_id
     and u.usage_date = r.usage_date
    left join public.bluesky_follow_campaigns c
      on c.id = r.campaign_id
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
    select l.id, l.member_id, l.campaign_id, l.action_id, l.provider_intent_at
      from public.bluesky_campaign_attempt_ledger l
     where l.reservation_id = p_reservation_id
       and l.counted_at is null
       for update
  ),
  resolved as (
    select p.id,
           p.provider_intent_at,
           coalesce(named.status, legacy.status) as action_status,
           coalesce(named.follow_uri, legacy.follow_uri) as follow_uri,
           -- A LATER intent exists for the same member. This row paid
           -- for a request the provider rejected before writing; the
           -- action was re-opened and a later reservation paid for the
           -- attempt that actually resolved it. The unit stays spent —
           -- the request was made — but its OUTCOME belongs to the
           -- later row, or the same follow would be counted twice.
           exists (
             select 1
               from public.bluesky_campaign_attempt_ledger later
              where later.member_id = p.member_id
                and later.id <> p.id
                and later.provider_intent_at is not null
                and p.provider_intent_at is not null
                and later.provider_intent_at > p.provider_intent_at
           ) as superseded
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
           provider_intent_at,
           case
             when superseded then 'superseded'
             -- FOLLOW: a succeeded action WITHOUT a follow record is
             -- the already-following path — observed, not created, and
             -- no provider budget was spent.
             --
             -- UNFOLLOW: the same two facts mean the opposite. A
             -- succeeded action WITH a record uri deleted that record;
             -- one WITHOUT means the follow was already absent when the
             -- run reached it, which is a neutral success costing
             -- nothing.
             when action_status = 'succeeded' and follow_uri is not null
               then 'succeeded'
             when action_status = 'succeeded' then 'already_in_state'
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
     returning c.outcome, c.provider_intent_at
  )
  select
    count(*) filter (where outcome = 'succeeded')::int,
    count(*) filter (where outcome = 'already_in_state')::int,
    count(*) filter (where outcome = 'failed')::int,
    count(*) filter (where outcome = 'skipped')::int,
    count(*) filter (where outcome = 'unknown')::int,
    count(*) filter (where outcome = 'succeeded')::int,
    count(*) filter (where provider_intent_at is not null)::int,
    count(*)::int
  into v_succeeded, v_already, v_failed, v_skipped, v_unresolved,
       v_records, v_intents, v_folded
  from counted;

  if v_folded = 0 then
    return 0;
  end if;

  -- `attempted_count` is NOT touched here. It was incremented at
  -- provider intent, one member at a time, which is why attempts
  -- survive a crash.
  if v_kind = 'unfollow' then
    update public.bluesky_follow_campaign_runs
       set succeeded_count      = succeeded_count + v_succeeded,
           already_absent_count = already_absent_count + v_already,
           failed_count         = failed_count + v_failed,
           skipped_count        = skipped_count + v_skipped,
           reconciliation_required_count =
             reconciliation_required_count + v_unresolved,
           last_chunk_at        = now()
     where id = v_run_id;

    if v_usage_id is not null then
      -- DELETES, never `follows_created`. The identity's follow count
      -- must not rise because it stopped following someone.
      update public.bluesky_identity_daily_usage
         set unfollows_deleted    = unfollows_deleted + v_records,
             delete_attempts_made = delete_attempts_made + v_intents,
             updated_at = now()
       where id = v_usage_id;
    end if;
  else
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
  end if;

  return v_folded;
end;
$function$;


-- =====================================================================
-- C. Re-opening an action the provider REJECTED before writing
-- =====================================================================
--
-- Only for a rejection that proves nothing was written: an auth error
-- (ExpiredToken and its kin), a rate limit, a structural 4xx. A network
-- error, a 5xx or an unparseable 2xx is AMBIGUOUS and must stay in
-- reconciliation — this function refuses those codes.
--
-- The unit the earlier attempt spent stays spent. The ledger row keeps
-- its intent (immutable). The action goes back to `pending` with the
-- marker cleared, so the ordinary claim path sees "owed a first
-- attempt" and the reconciliation takeover (A) sees nothing to read.

create or replace function public.reopen_bluesky_campaign_action(
  p_workspace_id uuid,
  p_action_id uuid,
  p_member_id uuid,
  p_error_code text,
  p_error_message text
)
returns table (reopened boolean, refused_reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.bluesky_relationship_actions;
  v_definite constant text[] := array[
    'ExpiredToken', 'InvalidToken', 'AuthMissing', 'AuthenticationRequired',
    'session_expired', 'RateLimitExceeded', 'rate_limited',
    'provider_rejected_before_write'
  ];
begin
  select * into v_action
    from public.bluesky_relationship_actions
   where id = p_action_id
     and workspace_id = p_workspace_id
     for update;

  if v_action.id is null then
    reopened := false; refused_reason := 'unknown_action'; return next; return;
  elsif v_action.campaign_member_id is distinct from p_member_id then
    reopened := false; refused_reason := 'member_mismatch'; return next; return;
  elsif v_action.status in ('succeeded', 'failed', 'skipped') then
    reopened := false; refused_reason := 'action_terminal'; return next; return;
  elsif p_error_code is null or not (p_error_code = any (v_definite)) then
    -- Not a code that proves the request was refused before writing.
    reopened := false; refused_reason := 'not_a_definite_rejection';
    return next; return;
  end if;

  update public.bluesky_relationship_actions
     set status = 'pending',
         provider_in_flight_at = null,
         finished_at = null,
         provider_error_code = p_error_code,
         provider_error_message = p_error_message,
         reconciliation_note =
           'Bluesky refused the request before writing anything (' ||
           p_error_code || '). Nothing to reconcile; the profile is owed a ' ||
           'real retry. The unit the refused request spent stays spent.'
   where id = p_action_id;

  reopened := true; refused_reason := null;
  return next;
end;
$$;

revoke all on function public.reopen_bluesky_campaign_action(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.reopen_bluesky_campaign_action(uuid, uuid, uuid, text, text)
  to service_role;

-- =====================================================================
-- D. Resuming today's run after a RECOVERABLE stop
-- =====================================================================
--
-- The deployed `resume_bluesky_campaign_run` moves only a rate-limited
-- run, which is right for the scheduler acting on its own. This one is
-- for the moment the SESSION is known to work again — the operator
-- reconnected and the dispatcher (or the activate action) verified it —
-- and it moves a run stopped for authentication, an internal dispatch
-- error, or a rate limit whose reset has passed.
--
-- It never moves a run whose campaign an OPERATOR paused: that state is
-- on the campaign, the campaign is not listed while paused, and this
-- function is only reached through an active or re-activated campaign.
-- It never creates a second run for the day, never touches counters,
-- and never touches a completed or cancelled run.

create or replace function public.resume_bluesky_campaign_run_after_recovery(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_local_date date
)
returns table (resumed boolean, run_id uuid, run_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
begin
  select * into v_run
    from public.bluesky_follow_campaign_runs
   where workspace_id = p_workspace_id
     and campaign_id = p_campaign_id
     and local_date = p_local_date
   for update;

  if v_run.id is null then
    resumed := false; run_id := null; run_status := null;
    return next; return;
  end if;

  if v_run.status = 'running' then
    resumed := false; run_id := v_run.id; run_status := v_run.status;
    return next; return;
  end if;

  if v_run.status in ('paused', 'failed', 'rate_limited')
     and (v_run.rate_limited_until is null or v_run.rate_limited_until <= now())
  then
    update public.bluesky_follow_campaign_runs
       set status = 'running',
           rate_limited_until = null,
           last_error_code = null,
           last_error_message = null
     where id = v_run.id
     returning * into v_run;
    resumed := true;
  else
    resumed := false;
  end if;

  run_id := v_run.id; run_status := v_run.status;
  return next;
end;
$$;

revoke all on function public.resume_bluesky_campaign_run_after_recovery(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.resume_bluesky_campaign_run_after_recovery(uuid, uuid, date)
  to service_role;

-- =====================================================================
-- E. Conservation, computed by the database
-- =====================================================================
--
-- Every member is in exactly one category. The categories are the
-- brief's, derived from status plus the closed reason code a `skipped`
-- member must carry. `queued_total` is the frozen denominator.

create or replace function public.bluesky_campaign_conservation(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns table (
  queued_total bigint,
  pending bigint,
  running bigint,
  retryable bigint,
  reconciliation_required bigint,
  succeeded bigint,
  already_following bigint,
  protected bigint,
  actor_not_found bigint,
  blocked bigint,
  invalid bigint,
  failed_structural bigint,
  cancelled bigint,
  actionable_remaining bigint,
  open_leases bigint,
  open_reservations bigint,
  outstanding_intents bigint,
  unresolved_actions bigint,
  categorised_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with m as (
    select m.id, m.status, m.last_error_code,
           exists (
             select 1 from public.bluesky_relationship_actions a
              where a.campaign_member_id = m.id
                and a.status = 'reconciliation_required'
           ) as reconciling
      from public.bluesky_follow_campaign_members m
     where m.workspace_id = p_workspace_id
       and m.campaign_id = p_campaign_id
  ),
  cat as (
    select id,
      case
        when status = 'queued' then 'pending'
        when status in ('claimed', 'running', 'provider_in_flight') then 'running'
        when status = 'retryable' and reconciling then 'reconciliation_required'
        when status = 'retryable' then 'retryable'
        when status = 'succeeded' then 'succeeded'
        when status in ('already_following', 'already_not_following') then 'already_following'
        when status = 'protected' then 'protected'
        -- The closed reason set the workers persist on a terminal skip.
        when status = 'skipped' and last_error_code in ('actor_not_found', 'not_found')
          then 'actor_not_found'
        when status = 'skipped' and last_error_code in ('blocked', 'blocking', 'blocked_by', 'self')
          then 'blocked'
        -- dry_run, conflict, no_record_target, ineligible, invalid — an
        -- explicit reason on every one; none of them is a person the
        -- campaign lost.
        when status = 'skipped' then 'invalid'
        when status = 'failed_structural' then 'failed_structural'
        when status = 'cancelled' then 'cancelled'
        else 'invalid'
      end as category
    from m
  ),
  counts as (
    select
      count(*) filter (where category = 'pending') as pending,
      count(*) filter (where category = 'running') as running,
      count(*) filter (where category = 'retryable') as retryable,
      count(*) filter (where category = 'reconciliation_required') as reconciliation_required,
      count(*) filter (where category = 'succeeded') as succeeded,
      count(*) filter (where category = 'already_following') as already_following,
      count(*) filter (where category = 'protected') as protected,
      count(*) filter (where category = 'actor_not_found') as actor_not_found,
      count(*) filter (where category = 'blocked') as blocked,
      count(*) filter (where category = 'invalid') as invalid,
      count(*) filter (where category = 'failed_structural') as failed_structural,
      count(*) filter (where category = 'cancelled') as cancelled,
      count(*) as total
    from cat
  )
  select
    (select count(*) from m) as queued_total,
    c.pending, c.running, c.retryable, c.reconciliation_required,
    c.succeeded, c.already_following, c.protected, c.actor_not_found,
    c.blocked, c.invalid, c.failed_structural, c.cancelled,
    c.pending + c.running + c.retryable + c.reconciliation_required
      as actionable_remaining,
    (select count(*) from public.bluesky_follow_campaign_members x
      where x.workspace_id = p_workspace_id and x.campaign_id = p_campaign_id
        and x.lease_expires_at is not null and x.lease_expires_at >= now()
        and x.status in ('claimed', 'running', 'provider_in_flight')) as open_leases,
    (select count(*) from public.bluesky_campaign_quota_reservations r
      where r.workspace_id = p_workspace_id and r.campaign_id = p_campaign_id
        and r.status in ('open', 'held')) as open_reservations,
    (select count(*) from public.bluesky_relationship_actions a
      where a.workspace_id = p_workspace_id and a.campaign_id = p_campaign_id
        and a.provider_in_flight_at is not null) as outstanding_intents,
    (select count(*) from public.bluesky_relationship_actions a
      where a.workspace_id = p_workspace_id and a.campaign_id = p_campaign_id
        and a.status in ('pending', 'running', 'reconciliation_required')) as unresolved_actions,
    c.total as categorised_total
  from counts c;
$$;

revoke all on function public.bluesky_campaign_conservation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bluesky_campaign_conservation(uuid, uuid)
  to service_role;

-- A campaign may complete ONLY when nothing actionable remains and no
-- lease, reservation, intent or unresolved action is outstanding. The
-- dispatcher asks this rather than counting statuses itself.
create or replace function public.bluesky_campaign_may_complete(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select c.actionable_remaining = 0
     and c.open_leases = 0
     and c.open_reservations = 0
     and c.outstanding_intents = 0
     and c.unresolved_actions = 0
    from public.bluesky_campaign_conservation(p_workspace_id, p_campaign_id) c;
$$;

revoke all on function public.bluesky_campaign_may_complete(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bluesky_campaign_may_complete(uuid, uuid)
  to service_role;

-- =====================================================================
-- Privileges restated for the two replaced functions. CREATE OR
-- REPLACE preserves them, but a fresh database and a repaired one must
-- prove the same state.
-- =====================================================================

revoke all on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  to service_role;

revoke all on function public.fold_bluesky_ledger_outcomes(uuid)
  from public, anon, authenticated;
grant execute on function public.fold_bluesky_ledger_outcomes(uuid)
  to service_role;
