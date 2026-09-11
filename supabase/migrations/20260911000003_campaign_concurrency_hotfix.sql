-- HOTFIX — forward-only. Bluesky follow campaigns: concurrency,
-- permissions, tenant integrity, kill switches and rate-limit recovery.
--
-- 20260911000002 shipped six defects. This migration is additive and
-- idempotent; it drops nothing that holds data and rewrites no row.
--
-- 1. CRITICAL — the worker RPCs were revoked from PUBLIC/anon/
--    authenticated and never granted to service_role. Revoking from
--    PUBLIC removes the default EXECUTE that service_role relied on, so
--    `claim_bluesky_campaign_members` fails for the only role that
--    calls it. The deployed feature cannot claim a single member.
--
-- 2. Quota was reserved by read-then-later-increment. Two concurrent
--    dispatcher runs both read "0 used today", both computed the full
--    quota, and collectively attempted twice it. Disjoint member claims
--    do not bound total attempts; only a reservation does.
--
-- 3. Run counters were written as absolutes computed from a snapshot
--    read at the start of the tick — a classic lost update.
--
-- 4. `ON CONFLICT (workspace_id)` cannot infer a PARTIAL unique index,
--    so every workspace-global kill-switch write errored at runtime.
--    The switch could not be engaged.
--
-- 5. No composite tenant constraint tied a member/run/source to its
--    campaign's workspace. Integrity depended on application filtering
--    and UUID secrecy.
--
-- 6. Rate-limit metadata was never persisted and a `rate_limited` run
--    could never return to `running`, so a 429 stopped the campaign for
--    the remainder of that local day even after the reset had passed.

set search_path = public;

-- =====================================================================
-- 1. EXECUTE for the role that actually calls these
-- =====================================================================
--
-- The worker authenticates as service_role. `revoke all ... from public`
-- in the previous migration removed the implicit grant that made these
-- callable; nothing granted it back. Explicit, least-privilege grants
-- to exactly one role.

do $$
declare
  fn text;
begin
  -- service_role exists in Supabase but not in a bare Postgres used for
  -- tests; create it there so the grants below are exercised for real
  -- rather than skipped.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role noinherit;
  end if;

  foreach fn in array array[
    'claim_bluesky_campaign_members(uuid, uuid, integer, integer, text)',
    'release_bluesky_campaign_members(uuid, uuid, uuid[])',
    'ensure_bluesky_campaign_run(uuid, uuid, date, integer, integer, text)',
    'record_bluesky_identity_usage(uuid, uuid, date, integer, integer)'
  ] loop
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;

-- =====================================================================
-- 2. Reserved quota
-- =====================================================================
--
-- `attempted_count` is what has been tried. `reserved_count` is what has
-- been PROMISED to in-flight workers. They are different numbers and
-- conflating them is what allowed two dispatchers to over-attempt:
-- worker A has reserved 100 but attempted 3, and worker B must see 100
-- as spent, not 3.

alter table public.bluesky_follow_campaign_runs
  add column if not exists reserved_count integer not null default 0;

comment on column public.bluesky_follow_campaign_runs.reserved_count is
  'Quota promised to in-flight workers. A second dispatcher must treat '
  'this as spent even though those attempts have not happened yet — '
  'otherwise both reserve the same headroom.';

alter table public.bluesky_identity_daily_usage
  add column if not exists reserved_count integer not null default 0;

comment on column public.bluesky_identity_daily_usage.reserved_count is
  'Per-account quota promised to in-flight workers across ALL campaigns '
  'using this identity.';

-- =====================================================================
-- 3. Atomic reservation
-- =====================================================================
--
-- One transaction that: locks the run row and the identity-usage row,
-- computes the headroom that actually remains, reserves the smaller of
-- what was asked and what is available, and claims exactly that many
-- members.
--
-- The locks are the point. `select ... for update` on both rows
-- serialises concurrent reservations against each other, so the read of
-- "how much is left" and the write of "I am taking this much" cannot be
-- interleaved by another session. Without them the arithmetic is a
-- read-modify-write across two statements and two dispatchers race.
--
-- Lock ORDER is fixed — identity usage, then run — because a function
-- that sometimes takes them the other way round deadlocks when two
-- campaigns share an identity.

create or replace function public.reserve_bluesky_campaign_quota(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_requested integer,
  p_identity_ceiling integer,
  p_chunk_size integer,
  p_lease_seconds integer,
  p_claimed_by text
)
returns table (
  reserved integer,
  member_id uuid,
  subject_did text,
  current_handle text,
  import_sequence bigint,
  attempt_count integer,
  provider_record_rkey text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
  v_usage public.bluesky_identity_daily_usage;
  v_run_headroom integer;
  v_live_leases integer;
  v_identity_headroom integer;
  v_grant integer;
begin
  -- Fixed lock order: identity first, then run. Two campaigns sharing an
  -- identity would deadlock if either order were possible.
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
    reserved := 0;
    return;
  end if;

  -- A run that is not running reserves nothing. Checked under the lock
  -- so a pause landing mid-reservation is honoured.
  if v_run.status <> 'running' then
    reserved := 0;
    return;
  end if;

  -- Headroom is against effective quota minus BOTH what has been
  -- attempted and what is already reserved by another worker.
  -- Reconcile the reservation against ground truth.
  --
  -- `reserved_count` should equal the members that are ACTUALLY leased
  -- right now — including another live worker's claims, which is what
  -- keeps two dispatchers honest with each other.
  --
  -- Recomputing rather than decrementing matters. A worker killed
  -- mid-chunk never reports its outcome, so a decrement leaves a
  -- residue for every member it had already finished, and those
  -- residues accumulate across crashes until a small daily quota is
  -- permanently consumed. Setting the value from the rows themselves is
  -- self-healing: one crash costs a bounded under-count of attempts,
  -- never a shrinking day.
  select count(*)::int into v_live_leases
    from public.bluesky_follow_campaign_members c
   where c.workspace_id = p_workspace_id
     and c.campaign_id = p_campaign_id
     and c.status in ('claimed', 'running')
     and c.lease_expires_at is not null
     and c.lease_expires_at >= now();

  if v_live_leases <> v_run.reserved_count then
    update public.bluesky_follow_campaign_runs
       set reserved_count = v_live_leases
     where id = p_run_id;
    update public.bluesky_identity_daily_usage
       set reserved_count = greatest(
             reserved_count - (v_run.reserved_count - v_live_leases), 0)
     where id = v_usage.id;

    select * into v_run
      from public.bluesky_follow_campaign_runs where id = p_run_id;
    select * into v_usage
      from public.bluesky_identity_daily_usage where id = v_usage.id;
  end if;

  -- Quota consumed so far today.
  --
  -- `attempted_count` counts members that reached the provider path.
  -- `already_following_count` is NOT among them — that branch returns
  -- before an attempt is made — so subtracting it here would
  -- double-count and let the day overrun. Only `skipped_count`
  -- (dry run, deleted account, ineligible) is an attempt that consumed
  -- no quota.
  v_run_headroom := greatest(
    0,
    v_run.effective_daily_quota
      - greatest(v_run.attempted_count - v_run.skipped_count, 0)
      - v_run.reserved_count
  );

  v_identity_headroom := greatest(
    0,
    coalesce(p_identity_ceiling, 0)
      - v_usage.follows_created
      - v_usage.reserved_count
  );

  v_grant := least(
    greatest(coalesce(p_requested, 0), 0),
    v_run_headroom,
    v_identity_headroom,
    least(greatest(coalesce(p_chunk_size, 1), 1), 100)
  );

  if v_grant <= 0 then
    reserved := 0;
    return;
  end if;

  -- Claim exactly the reserved number. SKIP LOCKED keeps two workers off
  -- the same rows; the reservation above keeps them off the same quota.
  create temp table if not exists _claimed_members (
    id uuid, subject_did text, current_handle text,
    import_sequence bigint, attempt_count integer, provider_record_rkey text
  ) on commit drop;
  delete from _claimed_members;

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
         lease_expires_at = now()
           + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 60), 10), 3600))
   where m.id in (select id from _claimed_members);

  -- Reserve only what was actually claimed. Fewer members than granted
  -- means the queue ran out, and reserving the difference would leak
  -- quota that nothing will ever release.
  select count(*)::int into v_grant from _claimed_members;
  if v_grant <= 0 then
    reserved := 0;
    return;
  end if;

  update public.bluesky_follow_campaign_runs
     set reserved_count = reserved_count + v_grant
   where id = p_run_id;

  update public.bluesky_identity_daily_usage
     set reserved_count = reserved_count + v_grant
   where id = v_usage.id;

  return query
  select v_grant, c.id, c.subject_did, c.current_handle,
         c.import_sequence, c.attempt_count, c.provider_record_rkey
    from _claimed_members c
   order by c.import_sequence;
end;
$$;

comment on function public.reserve_bluesky_campaign_quota is
  'Atomically reserve quota AND claim exactly that many members. Locks '
  'the identity-usage row then the run row (fixed order — the reverse '
  'deadlocks when two campaigns share an identity), so the read of '
  'remaining headroom and the write reserving it cannot interleave. '
  'Disjoint member claims do not bound total attempts; only this does.';

revoke all on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  to service_role;

-- Release an unused reservation.
--
-- Called when a chunk finishes with fewer attempts than it reserved —
-- quota released back must equal quota reserved and never attempted, or
-- the day silently shrinks.
create or replace function public.release_bluesky_campaign_reservation(
  p_workspace_id uuid,
  p_run_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_amount integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer := greatest(coalesce(p_amount, 0), 0);
begin
  if v_amount = 0 then return; end if;

  update public.bluesky_follow_campaign_runs
     set reserved_count = greatest(reserved_count - v_amount, 0)
   where id = p_run_id
     and workspace_id = p_workspace_id;

  update public.bluesky_identity_daily_usage
     set reserved_count = greatest(reserved_count - v_amount, 0)
   where workspace_id = p_workspace_id
     and operator_account_id = p_operator_account_id
     and usage_date = p_usage_date;
end;
$$;

revoke all on function public.release_bluesky_campaign_reservation(
  uuid, uuid, uuid, date, integer) from public, anon, authenticated;
grant execute on function public.release_bluesky_campaign_reservation(
  uuid, uuid, uuid, date, integer) to service_role;

-- =====================================================================
-- 4. Outcome counters as DELTAS
-- =====================================================================
--
-- The previous code read the run at the start of a tick, added its own
-- chunk totals in memory, and wrote the absolute result. Two workers
-- doing that lose each other's increments entirely. Every counter now
-- moves by a delta applied in SQL, and the reservation is consumed in
-- the same statement.

create or replace function public.apply_bluesky_run_outcome(
  p_workspace_id uuid,
  p_run_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_attempted integer,
  p_succeeded integer,
  p_already_following integer,
  p_skipped integer,
  p_failed integer,
  p_records_created integer,
  p_consume_reservation integer,
  p_consecutive_failures integer,
  p_rate_limited_until timestamptz,
  p_rate_limit_remaining integer,
  p_rate_limit_reset_at timestamptz
)
returns public.bluesky_follow_campaign_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
  v_consume integer := greatest(coalesce(p_consume_reservation, 0), 0);
begin
  update public.bluesky_follow_campaign_runs
     set attempted_count         = attempted_count + greatest(coalesce(p_attempted, 0), 0),
         succeeded_count         = succeeded_count + greatest(coalesce(p_succeeded, 0), 0),
         already_following_count = already_following_count + greatest(coalesce(p_already_following, 0), 0),
         skipped_count           = skipped_count + greatest(coalesce(p_skipped, 0), 0),
         failed_count            = failed_count + greatest(coalesce(p_failed, 0), 0),
         -- Consecutive failures is a RUNNING STATE, not a total: the
         -- caller sends the value observed at the end of its chunk.
         consecutive_failures    = greatest(coalesce(p_consecutive_failures, 0), 0),
         reserved_count          = greatest(reserved_count - v_consume, 0),
         rate_limited_until      = coalesce(p_rate_limited_until, rate_limited_until),
         rate_limit_remaining    = coalesce(p_rate_limit_remaining, rate_limit_remaining),
         rate_limit_reset_at     = coalesce(p_rate_limit_reset_at, rate_limit_reset_at),
         last_chunk_at           = now()
   where id = p_run_id
     and workspace_id = p_workspace_id
  returning * into v_run;

  -- Identity usage moves by the same deltas, and the reservation is
  -- released here too so it cannot be double-counted.
  update public.bluesky_identity_daily_usage
     set follows_created = follows_created + greatest(coalesce(p_records_created, 0), 0),
         attempts_made   = attempts_made + greatest(coalesce(p_attempted, 0), 0),
         reserved_count  = greatest(reserved_count - v_consume, 0)
   where workspace_id = p_workspace_id
     and operator_account_id = p_operator_account_id
     and usage_date = p_usage_date;

  return v_run;
end;
$$;

comment on function public.apply_bluesky_run_outcome is
  'Apply outcome DELTAS and release the consumed reservation in one '
  'statement. Writing absolute counters computed from a snapshot read '
  'at the start of a tick loses every concurrent increment.';

revoke all on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, integer, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, integer, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz)
  to service_role;

-- =====================================================================
-- 5. Durable action rows — the idempotency the unique index promised
-- =====================================================================
--
-- 20260911000002 added `unique (campaign_id, campaign_member_id)` to
-- bluesky_relationship_actions and called it "the database-level
-- guarantee that a member cannot be followed twice". The worker never
-- inserted a row, so the index guarded an empty set: it constrained
-- nothing, and campaign follows were invisible in History.
--
-- The row is now created BEFORE the provider call and carries the
-- in-flight state, which is what makes a crash recoverable:
--
--   (no row)            nothing has been sent
--   provider_in_flight  a createRecord MAY have been issued
--   succeeded/failed/   terminal
--   reconciliation_required
--
-- A worker that finds an existing `provider_in_flight` row for a member
-- must NOT send another createRecord. createRecord is not idempotent —
-- it mints a fresh rkey per call — so a second attempt after a possible
-- success leaves two follow records and Signal tracking one.

alter table public.bluesky_relationship_actions
  add column if not exists provider_in_flight_at timestamptz;

comment on column public.bluesky_relationship_actions.provider_in_flight_at is
  'Set immediately before a provider mutation and cleared when the '
  'outcome is known. A row still carrying this after a lease expires '
  'means the request MAY have succeeded — the next worker reconciles '
  'and never re-sends.';

-- The partial unique index from 20260911000002 excluded 'skipped', so a
-- member whose first attempt was skipped could receive a second action
-- row. That is right for a dry run (nothing was sent) and wrong for a
-- real attempt. Replace it with one that admits exactly one NON-skipped
-- action per (campaign, member).
drop index if exists public.bluesky_relationship_actions_campaign_member_idx;

create unique index if not exists bluesky_campaign_member_action_once
  on public.bluesky_relationship_actions (campaign_id, campaign_member_id)
  where campaign_id is not null
    and campaign_member_id is not null
    and status <> 'skipped';

comment on index public.bluesky_campaign_member_action_once is
  'At most one non-skipped action per (campaign, member). This is what '
  'makes a duplicate cron delivery, a re-claimed lease and a retried '
  'chunk collide in the database instead of creating a second follow.';

-- Claim the action row for a member, atomically.
--
-- Returns the row and whether THIS caller may proceed to the provider.
-- The three outcomes are distinct and the caller must treat them
-- differently:
--
--   may_mutate = true    no prior attempt; send the mutation
--   may_mutate = false,
--     needs_reconcile    a previous attempt may have reached the
--                        provider; read relationship truth, never send
--   may_mutate = false,
--     terminal           already finished; skip entirely
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

    -- pending / running with an in-flight marker: a createRecord may
    -- already have been issued. Reconciliation ONLY.
    may_mutate := false;
    needs_reconcile := true;
    terminal := false;
    update public.bluesky_relationship_actions
       set status = 'running', started_at = coalesce(started_at, now())
     where id = v_existing.id;
    return next; return;
  end if;

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
    now(), now()
  )
  returning id into v_id;

  action_id := v_id;
  may_mutate := true;
  needs_reconcile := false;
  terminal := false;
  existing_status := null;
  return next;
exception
  -- Lost the race to another worker between the select and the insert.
  -- The winner owns the mutation; we reconcile rather than send.
  when unique_violation then
    select * into v_existing
      from public.bluesky_relationship_actions
     where campaign_id = p_campaign_id
       and campaign_member_id = p_member_id
       and status <> 'skipped';
    action_id := v_existing.id;
    existing_status := v_existing.status;
    may_mutate := false;
    needs_reconcile := v_existing.status not in
      ('succeeded', 'failed', 'reconciliation_required');
    terminal := not needs_reconcile;
    return next;
end;
$$;

comment on function public.claim_bluesky_campaign_action is
  'Create or take over the audit row for one member, and say whether '
  'this caller may call the provider. A row already marked in-flight '
  'means a createRecord MAY have been sent — the answer is reconcile, '
  'never send again, because createRecord mints a new rkey per call.';

revoke all on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_bluesky_campaign_action(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, uuid)
  to service_role;

-- =====================================================================
-- 6. Tenant integrity — enforced by the schema, not by filtering
-- =====================================================================
--
-- Nothing tied a member's workspace_id to its campaign's. Application
-- filtering and UUID secrecy were the only things keeping a member,
-- run or source row from naming one workspace while its parent named
-- another. A composite foreign key makes the pair itself the reference,
-- so a mismatch is rejected by the database.

create unique index if not exists bluesky_campaigns_id_workspace_key
  on public.bluesky_follow_campaigns (id, workspace_id);

create unique index if not exists bluesky_campaign_members_id_workspace_key
  on public.bluesky_follow_campaign_members (id, workspace_id);

create unique index if not exists bluesky_target_profiles_id_workspace_key
  on public.bluesky_target_profiles (id, workspace_id);

create unique index if not exists growth_accounts_id_workspace_key
  on public.growth_accounts (id, workspace_id);

do $$
begin
  -- The acting identity must belong to the campaign's workspace.
  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaigns_identity_same_workspace'
  ) then
    alter table public.bluesky_follow_campaigns
      add constraint bluesky_campaigns_identity_same_workspace
      foreign key (operator_account_id, workspace_id)
      references public.growth_accounts (id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaign_members_same_workspace'
  ) then
    alter table public.bluesky_follow_campaign_members
      add constraint bluesky_campaign_members_same_workspace
      foreign key (campaign_id, workspace_id)
      references public.bluesky_follow_campaigns (id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaign_runs_same_workspace'
  ) then
    alter table public.bluesky_follow_campaign_runs
      add constraint bluesky_campaign_runs_same_workspace
      foreign key (campaign_id, workspace_id)
      references public.bluesky_follow_campaigns (id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaign_sources_same_workspace'
  ) then
    alter table public.bluesky_campaign_member_sources
      add constraint bluesky_campaign_sources_same_workspace
      foreign key (member_id, workspace_id)
      references public.bluesky_follow_campaign_members (id, workspace_id)
      on delete cascade;
  end if;

  -- A source may name a target profile only from the same workspace.
  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_campaign_sources_target_same_workspace'
  ) then
    alter table public.bluesky_campaign_member_sources
      add constraint bluesky_campaign_sources_target_same_workspace
      foreign key (target_profile_id, workspace_id)
      references public.bluesky_target_profiles (id, workspace_id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_identity_usage_same_workspace'
  ) then
    alter table public.bluesky_identity_daily_usage
      add constraint bluesky_identity_usage_same_workspace
      foreign key (operator_account_id, workspace_id)
      references public.growth_accounts (id, workspace_id)
      on delete cascade;
  end if;
end;
$$;

-- =====================================================================
-- 7. Kill switches — an enforceable constraint
-- =====================================================================
--
-- The global switch was a PARTIAL unique index
-- (`where operator_account_id is null`). `ON CONFLICT (workspace_id)`
-- cannot infer a partial index without repeating its predicate, which
-- PostgREST cannot express — so every workspace-global write raised
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". The switch could not be engaged at all.
--
-- A generated key column turns "global" into a real value, so one
-- ordinary unique CONSTRAINT covers both cases and ON CONFLICT works.

alter table public.bluesky_campaign_kill_switches
  add column if not exists identity_key uuid
    generated always as (
      coalesce(operator_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) stored;

comment on column public.bluesky_campaign_kill_switches.identity_key is
  'operator_account_id, or the nil UUID for the workspace-global switch. '
  'Exists so ONE ordinary unique constraint covers both rows — a partial '
  'unique index cannot be used as an ON CONFLICT target.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bluesky_kill_switch_unique_scope'
  ) then
    alter table public.bluesky_campaign_kill_switches
      add constraint bluesky_kill_switch_unique_scope
      unique (workspace_id, identity_key);
  end if;
end;
$$;

-- The old partial indexes are now redundant with the constraint above
-- and would reject nothing it does not. Dropped by name; they hold no
-- data.
drop index if exists public.bluesky_kill_switch_global_idx;
drop index if exists public.bluesky_kill_switch_identity_idx;

-- =====================================================================
-- 8. RLS — writes require the permission, not merely membership
-- =====================================================================
--
-- 20260911000002 granted INSERT/UPDATE to any workspace member. The
-- server actions check `connect_platforms`, but a server action is not
-- an authorization boundary when an authenticated client holds an anon
-- key and can call PostgREST directly: a `viewer` could POST straight
-- to /rest/v1/bluesky_follow_campaigns and activate a campaign.
--
-- The permission matrix lives in TypeScript (core/teams/permissions.ts)
-- and is mirrored here for the roles that hold `connect_platforms`:
-- owner and admin. Editor, reviewer and viewer do not — note that a
-- reviewer CAN approve content, so this is a matrix and not a ladder,
-- and the SQL must not be written as `role >= something`.

create or replace function public.can_manage_bluesky_campaigns(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.workspace_members wm
     where wm.workspace_id = target
       and wm.user_id = auth.uid()
       -- Mirrors `connect_platforms` in core/teams/permissions.ts.
       -- Editor and reviewer are deliberately absent: a reviewer may
       -- approve content and still must not act as the account in
       -- public, unattended.
       and wm.role in ('owner', 'admin')
  );
$$;

comment on function public.can_manage_bluesky_campaigns is
  'Mirrors the connect_platforms permission. Exists because a server '
  'action is not an authorization boundary while an authenticated '
  'client can write these tables through PostgREST directly.';

revoke all on function public.can_manage_bluesky_campaigns(uuid) from public;
grant execute on function public.can_manage_bluesky_campaigns(uuid)
  to anon, authenticated, service_role;

-- Reads stay open to every member: seeing that a campaign exists is not
-- the same as being able to start one, and hiding it would break the
-- read-only surfaces without protecting anything.
--
-- Writes are narrowed to the permission. Replacing the policies is
-- idempotent — each is dropped by name first.
do $$
declare
  t text;
begin
  foreach t in array array[
    'bluesky_follow_campaigns',
    'bluesky_follow_campaign_members',
    'bluesky_campaign_member_sources',
    'bluesky_follow_campaign_runs',
    'bluesky_identity_daily_usage',
    'bluesky_campaign_kill_switches'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || ': members insert', t);
    execute format('drop policy if exists %I on public.%I', t || ': members update', t);
    execute format('drop policy if exists %I on public.%I', t || ': members delete', t);
    execute format('drop policy if exists %I on public.%I', t || ': managers insert', t);
    execute format('drop policy if exists %I on public.%I', t || ': managers update', t);
    execute format('drop policy if exists %I on public.%I', t || ': managers delete', t);

    execute format(
      'create policy %I on public.%I for insert with check (public.can_manage_bluesky_campaigns(workspace_id))',
      t || ': managers insert', t);
    execute format(
      'create policy %I on public.%I for update using (public.can_manage_bluesky_campaigns(workspace_id)) with check (public.can_manage_bluesky_campaigns(workspace_id))',
      t || ': managers update', t);
  end loop;
end;
$$;

-- Deletes, narrowed the same way. Runs and identity usage remain
-- undeletable through the API: they are the record of what was
-- attempted and what it consumed.
drop policy if exists "bluesky_follow_campaigns: members delete"
  on public.bluesky_follow_campaigns;
create policy "bluesky_follow_campaigns: managers delete"
  on public.bluesky_follow_campaigns for delete
  using (public.can_manage_bluesky_campaigns(workspace_id) and status = 'draft');

create policy "bluesky_follow_campaign_members: managers delete"
  on public.bluesky_follow_campaign_members for delete
  using (public.can_manage_bluesky_campaigns(workspace_id));

create policy "bluesky_campaign_member_sources: managers delete"
  on public.bluesky_campaign_member_sources for delete
  using (public.can_manage_bluesky_campaigns(workspace_id));

create policy "bluesky_campaign_kill_switches: managers delete"
  on public.bluesky_campaign_kill_switches for delete
  using (public.can_manage_bluesky_campaigns(workspace_id));

-- =====================================================================
-- 9. Rate-limit recovery within the same local day
-- =====================================================================
--
-- A 429 set the run to `rate_limited`, and the dispatcher's
-- `if (run.status !== 'running') return` then refused it for the rest
-- of the local day — even after the provider's reset had passed. The
-- day's remaining quota was silently forfeited.
--
-- Recovery is a guarded transition rather than application logic so it
-- cannot resurrect a run that was paused or cancelled by a person, and
-- cannot run before the reset the provider reported.

create or replace function public.resume_bluesky_campaign_run(
  p_workspace_id uuid,
  p_run_id uuid
)
returns public.bluesky_follow_campaign_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
begin
  update public.bluesky_follow_campaign_runs
     set status = 'running',
         rate_limited_until = null,
         last_error_code = null,
         last_error_message = null
   where id = p_run_id
     and workspace_id = p_workspace_id
     -- ONLY a rate-limited run. A run paused or cancelled by an
     -- operator must never be resumed by the scheduler.
     and status = 'rate_limited'
     -- And only once the provider's own reset has passed.
     and (rate_limited_until is null or rate_limited_until <= now())
  returning * into v_run;

  if v_run.id is null then
    select * into v_run
      from public.bluesky_follow_campaign_runs
     where id = p_run_id and workspace_id = p_workspace_id;
  end if;
  return v_run;
end;
$$;

comment on function public.resume_bluesky_campaign_run is
  'Return a rate-limited run to running once the provider reset has '
  'passed — same run, same local day, same remaining quota. Guarded so '
  'an operator pause is never undone by the scheduler.';

revoke all on function public.resume_bluesky_campaign_run(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resume_bluesky_campaign_run(uuid, uuid)
  to service_role;

-- =====================================================================
-- 10. Table privileges for service_role
-- =====================================================================
--
-- The worker writes these tables directly as well as through the RPCs.
-- Granted explicitly rather than relying on a default that a future
-- `revoke ... from public` could remove, which is exactly how the RPC
-- grants went missing.

do $$
declare
  t text;
begin
  foreach t in array array[
    'bluesky_follow_campaigns',
    'bluesky_follow_campaign_members',
    'bluesky_campaign_member_sources',
    'bluesky_follow_campaign_runs',
    'bluesky_identity_daily_usage',
    'bluesky_campaign_kill_switches',
    'bluesky_relationship_actions'
  ] loop
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;
