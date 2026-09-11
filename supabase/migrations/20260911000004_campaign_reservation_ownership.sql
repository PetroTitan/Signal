-- =====================================================================
-- Bluesky follow campaigns — durable reservation ownership
-- =====================================================================
--
-- A SECOND forward-only migration, not an edit of 20260911000003.
--
-- 20260911000003 shipped with PR #182 and is merged. Once a migration
-- is on main it may be applied at any moment, so changing it in place
-- would silently diverge any database that already ran it from any
-- database that had not. Everything here is therefore additive and
-- idempotent, and assumes 20260911000003 has already run.
--
-- WHAT WAS WRONG
-- --------------
-- 20260911000003 replaced read-then-increment quota accounting with a
-- scalar `reserved_count` reconciled against member LEASE status. That
-- is still a race. The worker clears each member's lease in persist()
-- as it finishes, and settles the chunk afterwards, so between those
-- two moments the quota is spent but nothing on the member rows says
-- so:
--
--   A reserves 20   → reserved_count = 20
--   A finishes all 20 members, clearing each lease
--   ── here ──        0 live leases, and the run counters are still 0
--   B reserves        concludes reserved_count "drifted", resets it to
--                     0, and finds the whole day's quota available
--   B reserves 20   → reserved_count = 20 (B's)
--   A settles         consumes 20 — which is now B's reservation
--
-- The day goes over its limit and both workers believe they behaved.
-- Lease status answers "is anyone holding this row", which is a
-- different question from "is this quota spent".
--
-- Two further defects are repaired here:
--
--   - settlement took a scalar count and subtracted it from whatever
--     `reserved_count` happened to hold, so a late worker could consume
--     a reservation that was not its own, and a duplicate settlement
--     double-counted;
--   - "reserved nothing" was a bare zero, so the dispatcher could not
--     tell an exhausted quota from an empty queue from a paused run.

-- =====================================================================
-- 0. Retire the previous definitions
-- =====================================================================
--
-- `create or replace function` cannot change a return type, and both
-- reserve and settle change theirs. Dropping by exact signature keeps
-- this safe to re-run and leaves nothing behind under an old shape.

drop function if exists public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text);

drop function if exists public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, integer, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz);

drop function if exists public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, uuid, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz);

-- Superseded entirely: quota is released by settling the reservation
-- that owns it, or by the sweep expiring it. A free-floating "give back
-- N units" call is the very thing that let one worker return another's
-- quota.
drop function if exists public.release_bluesky_campaign_reservation(
  uuid, uuid, uuid, date, integer);

-- =====================================================================
-- 1. Reserved quota — OWNED, not inferred
-- =====================================================================
--
-- A scalar `reserved_count` reconciled against member lease status is
-- not safe, and the first version of this hotfix was wrong to use one.
--
-- The worker clears a member's lease in `persist()` as each member
-- finishes, and only settles the chunk afterwards. Between those two
-- moments the quota is spent but nothing on the member rows says so:
--
--   A reserves 20   → run.reserved_count = 20
--   A finishes all 20 members, clearing each lease
--   B calls reserve → sees 0 live leases, concludes reserved_count
--                     "drifted", resets it to 0, and finds the whole
--                     day's quota available again
--   B reserves 20   → run.reserved_count = 20 (B's)
--   A settles       → consumes 20, which is now B's reservation
--
-- The day goes over its limit and both workers believe they behaved.
-- Lease status answers "is anyone holding this row", which is a
-- different question from "is this quota spent".
--
-- So a reservation is now a ROW with an identity, and quota that has
-- not been settled is quota owned by an open reservation. Nothing is
-- inferred from leases.

-- The composite keys the reservation's tenant constraints reference.
-- Also created in section 6 with the rest of the tenant integrity work;
-- declared here too because a foreign key cannot reference a pair that
-- is not yet unique, and this table comes first. Both are
-- `if not exists`, so whichever runs first wins and the other is a
-- no-op.
create unique index if not exists bluesky_campaigns_id_workspace_key
  on public.bluesky_follow_campaigns (id, workspace_id);

create unique index if not exists growth_accounts_id_workspace_key
  on public.growth_accounts (id, workspace_id);

create table if not exists public.bluesky_campaign_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  run_id uuid not null references public.bluesky_follow_campaign_runs(id) on delete cascade,
  operator_account_id uuid not null,
  usage_date date not null,
  -- Units still PROMISED but not yet converted into attempts. Counts
  -- down as members reach provider intent, so it can legitimately
  -- reach zero while the reservation is still open.
  reserved_count integer not null check (reserved_count >= 0),
  -- open    — quota is outstanding; the worker is still processing.
  -- settled — the outcome was applied, exactly once.
  -- held    — the lease lapsed but a provider mutation MAY have been
  --           issued under it. Stays consumed until reconciliation.
  -- expired — the lease lapsed with no possible mutation. Released.
  status text not null default 'open'
    check (status in ('open', 'settled', 'held', 'expired')),
  claimed_by text,
  expires_at timestamptz not null,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

-- Tenant integrity: a reservation cannot point at another workspace's
-- campaign or identity.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bluesky_quota_reservations_campaign_tenant_fk'
  ) then
    alter table public.bluesky_campaign_quota_reservations
      add constraint bluesky_quota_reservations_campaign_tenant_fk
      foreign key (campaign_id, workspace_id)
      references public.bluesky_follow_campaigns (id, workspace_id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'bluesky_quota_reservations_identity_tenant_fk'
  ) then
    alter table public.bluesky_campaign_quota_reservations
      add constraint bluesky_quota_reservations_identity_tenant_fk
      foreign key (operator_account_id, workspace_id)
      references public.growth_accounts (id, workspace_id)
      on delete cascade;
  end if;
end;
$$;

-- The two hot lookups: outstanding quota for a run, and outstanding
-- quota for an identity across ALL of its campaigns on a given day.
create index if not exists bluesky_quota_reservations_run_open_idx
  on public.bluesky_campaign_quota_reservations (run_id)
  where status in ('open', 'held');

create index if not exists bluesky_quota_reservations_identity_open_idx
  on public.bluesky_campaign_quota_reservations
     (workspace_id, operator_account_id, usage_date)
  where status in ('open', 'held');

create index if not exists bluesky_quota_reservations_sweep_idx
  on public.bluesky_campaign_quota_reservations (expires_at)
  where status = 'open';

alter table public.bluesky_campaign_quota_reservations enable row level security;

-- ── The attempt ledger ───────────────────────────────────────────────
--
-- One durable row per (reservation, member), created when the member is
-- claimed for work and NEVER deleted.
--
-- This exists because a chunk's totals used to reach the database only
-- at settlement. A worker that died after following four people but
-- before settling left those four attempts recorded nowhere: the run
-- counters were untouched, the members looked finished, and their
-- actions had `provider_in_flight_at` cleared — so the sweep concluded
-- nothing could have reached the provider and returned the WHOLE
-- reservation to the pool. A real-Postgres control measured 104
-- available attempts against a quota of 100.
--
-- `provider_in_flight_at` cannot answer this question. It is cleared on
-- every terminal path, so it says "is a mutation in flight RIGHT NOW",
-- not "did this member ever reach the provider". The second question
-- needs a marker that is never cleared.
--
-- `provider_intent_at` is that marker. It is set immediately BEFORE
-- `createRecord` and never unset, and setting it is what converts a
-- reserved unit into a durable attempted one. Quota is therefore spent
-- at the moment of intent, in the same transaction, one member at a
-- time — so a crash can lose at most the OUTCOME of an attempt, never
-- the fact that it was made.
create table if not exists public.bluesky_campaign_attempt_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  run_id uuid not null
    references public.bluesky_follow_campaign_runs(id) on delete cascade,
  operator_account_id uuid not null,
  usage_date date not null,
  reservation_id uuid not null
    references public.bluesky_campaign_quota_reservations(id) on delete cascade,
  member_id uuid not null,
  action_id uuid,

  -- IMMUTABLE. Set once, immediately before the provider mutation, and
  -- never cleared. A row with this set has consumed a unit of quota
  -- whatever happened next — including "we never found out".
  provider_intent_at timestamptz,

  -- When this row's outcome was folded into the run counters. Null
  -- means "not yet counted", which is what makes folding idempotent
  -- whether it is done by settlement or by the crash sweep.
  counted_at timestamptz,

  created_at timestamptz not null default now(),

  -- Named, because `on conflict (reservation_id, member_id)` inside
  -- `reserve_bluesky_campaign_quota` is AMBIGUOUS: that function has
  -- OUT parameters of the same names, and plpgsql cannot tell the
  -- column from the parameter. Naming the constraint sidesteps the
  -- shadowing without renaming the function's result columns, which are
  -- part of its contract.
  constraint bluesky_attempt_ledger_once unique (reservation_id, member_id)
);

comment on column public.bluesky_campaign_attempt_ledger.provider_intent_at is
  'Set immediately before createRecord and NEVER cleared. The durable '
  'proof that a member reached the provider path. Distinct from '
  'bluesky_relationship_actions.provider_in_flight_at, which is cleared '
  'on every terminal path and therefore cannot answer a question about '
  'the past.';

create index if not exists bluesky_attempt_ledger_reservation_idx
  on public.bluesky_campaign_attempt_ledger (reservation_id);

create index if not exists bluesky_attempt_ledger_uncounted_idx
  on public.bluesky_campaign_attempt_ledger (run_id)
  where counted_at is null;

create index if not exists bluesky_attempt_ledger_member_idx
  on public.bluesky_campaign_attempt_ledger (member_id);

alter table public.bluesky_campaign_attempt_ledger enable row level security;

-- A ledger row is a historical fact. Nothing may edit one except to
-- stamp the two timestamps that only ever go from null to a value.
create or replace function public.bluesky_attempt_ledger_is_append_only()
returns trigger
language plpgsql
as $ledger$
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
  if new.reservation_id <> old.reservation_id
     or new.member_id <> old.member_id
     or new.run_id <> old.run_id then
    raise exception
      'bluesky_campaign_attempt_ledger identity columns are immutable';
  end if;
  return new;
end;
$ledger$;

drop trigger if exists bluesky_attempt_ledger_append_only
  on public.bluesky_campaign_attempt_ledger;
create trigger bluesky_attempt_ledger_append_only
  before update on public.bluesky_campaign_attempt_ledger
  for each row execute function public.bluesky_attempt_ledger_is_append_only();

-- Every claimed member names the reservation that paid for it. This is
-- what makes "which quota is this attempt spending" answerable without
-- consulting a lease.
alter table public.bluesky_follow_campaign_members
  add column if not exists reservation_id uuid
    references public.bluesky_campaign_quota_reservations(id) on delete set null;

create index if not exists bluesky_campaign_members_reservation_idx
  on public.bluesky_follow_campaign_members (reservation_id)
  where reservation_id is not null;

-- The scalar columns remain, but ONLY as a cache written from the sum
-- of open reservations. Nothing reads them to make a decision.
alter table public.bluesky_follow_campaign_runs
  add column if not exists reserved_count integer not null default 0;

comment on column public.bluesky_follow_campaign_runs.reserved_count is
  'CACHE of sum(reserved_count) over this run''s open/held reservations. '
  'Written by the RPCs for observability. Never read to decide headroom '
  '— the reservation rows are the authority.';

alter table public.bluesky_identity_daily_usage
  add column if not exists reserved_count integer not null default 0;

comment on column public.bluesky_identity_daily_usage.reserved_count is
  'CACHE of this identity''s outstanding reservations for the day, '
  'across every campaign using it. Observability only.';

-- =====================================================================
-- 2. Folding durable outcomes into the run counters
-- =====================================================================
--
-- Settlement used to add the surviving worker's in-memory chunk totals.
-- A worker that dies has no in-memory totals, so its real work was
-- simply lost. Recovery therefore has to read the same durable rows the
-- worker was writing as it went: the ledger, joined to the action rows
-- that record what each attempt turned into.
--
-- Called by BOTH settlement and the crash sweep, and idempotent through
-- `counted_at` — each row is folded exactly once, by whichever gets
-- there first.

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
  select run_id into v_run_id
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id;
  if v_run_id is null then
    return 0;
  end if;

  with pending as (
    select l.id, l.member_id
      from public.bluesky_campaign_attempt_ledger l
     where l.reservation_id = p_reservation_id
       and l.counted_at is null
       for update
  ),
  resolved as (
    select p.id,
           a.status as action_status,
           a.follow_uri
      from pending p
      left join public.bluesky_relationship_actions a
        on a.campaign_member_id = p.member_id
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
             -- reconciliation_required, still running, or no action row
             -- at all. The outcome is UNKNOWN, and unknown is counted
             -- as nothing but stays quota-consuming: its unit was spent
             -- at provider intent and is never given back.
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
  -- provider intent, one member at a time, which is the whole point:
  -- attempts survive a crash because they were never batched.
  update public.bluesky_follow_campaign_runs
     set succeeded_count = succeeded_count + v_succeeded,
         already_following_count = already_following_count + v_already,
         failed_count = failed_count + v_failed,
         skipped_count = skipped_count + v_skipped,
         last_chunk_at = now()
   where id = v_run_id;

  select u.id into v_usage_id
    from public.bluesky_identity_daily_usage u
    join public.bluesky_campaign_quota_reservations r
      on r.workspace_id = u.workspace_id
     and r.operator_account_id = u.operator_account_id
     and r.usage_date = u.usage_date
   where r.id = p_reservation_id;

  if v_usage_id is not null then
    update public.bluesky_identity_daily_usage
       set follows_created = follows_created + v_records,
           updated_at = now()
     where id = v_usage_id;
  end if;

  return v_folded;
end;
$$;

revoke execute on function public.fold_bluesky_ledger_outcomes(uuid)
  from public, anon, authenticated;
grant execute on function public.fold_bluesky_ledger_outcomes(uuid)
  to service_role;

-- =====================================================================
-- 2b. Consuming a unit of quota, one member at a time
-- =====================================================================
--
-- Called immediately BEFORE `createRecord`, and nowhere else.
--
-- It converts one reserved unit into a durable attempted unit in a
-- single transaction: stamp the immutable `provider_intent_at`,
-- increment the run's and the identity's attempt counters, and take the
-- unit off the reservation. After this returns, the quota is spent as
-- far as every other worker is concerned — regardless of what happens
-- to this one.
--
-- Idempotent per (reservation, member): a retry after a lost response
-- reports `already_consumed` and changes nothing.
--
-- It also refuses. A worker asking to mutate a member whose reservation
-- has no unit left is a worker that has lost track of its own budget,
-- and the honest answer is no.

create or replace function public.consume_bluesky_member_quota(
  p_workspace_id uuid,
  p_reservation_id uuid,
  p_member_id uuid,
  p_action_id uuid
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
  v_res public.bluesky_campaign_quota_reservations;
  v_usage public.bluesky_identity_daily_usage;
  v_ledger public.bluesky_campaign_attempt_ledger;
begin
  select * into v_res
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id
     and workspace_id = p_workspace_id
     for update;

  if v_res.id is null then
    consumed := false; already_consumed := false;
    refused_reason := 'unknown_reservation'; return next; return;
  end if;

  select * into v_ledger
    from public.bluesky_campaign_attempt_ledger
   where reservation_id = p_reservation_id
     and member_id = p_member_id
     for update;

  -- Already spent. Say so and change nothing.
  if v_ledger.id is not null and v_ledger.provider_intent_at is not null then
    consumed := false; already_consumed := true;
    refused_reason := null; return next; return;
  end if;

  if v_res.reserved_count <= 0 then
    consumed := false; already_consumed := false;
    refused_reason := 'reservation_exhausted'; return next; return;
  end if;

  -- Lock the identity's usage row in the same order the reservation
  -- path uses: identity, then run, then reservation.
  select * into v_usage
    from public.bluesky_identity_daily_usage
   where workspace_id = v_res.workspace_id
     and operator_account_id = v_res.operator_account_id
     and usage_date = v_res.usage_date
     for update;

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
       set provider_intent_at = now(),
           action_id = coalesce(p_action_id, action_id)
     where id = v_ledger.id;
  end if;

  update public.bluesky_campaign_quota_reservations
     set reserved_count = reserved_count - 1
   where id = p_reservation_id;

  update public.bluesky_follow_campaign_runs
     set attempted_count = attempted_count + 1,
         reserved_count = greatest(reserved_count - 1, 0)
   where id = v_res.run_id;

  if v_usage.id is not null then
    update public.bluesky_identity_daily_usage
       set attempts_made = attempts_made + 1,
           reserved_count = greatest(reserved_count - 1, 0),
           updated_at = now()
     where id = v_usage.id;
  end if;

  consumed := true; already_consumed := false; refused_reason := null;
  return next;
end;
$$;

revoke execute on function public.consume_bluesky_member_quota(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.consume_bluesky_member_quota(uuid, uuid, uuid, uuid)
  to service_role;

-- =====================================================================
-- 2c. Reservation sweep
-- =====================================================================
--
-- A lapsed reservation belongs to a worker that is gone. Two things
-- have to happen, in this order:
--
--   1. fold whatever its members durably achieved into the run
--      counters, because the worker never got to report them;
--   2. release what is LEFT on the reservation.
--
-- What is left is, by construction, only units that never reached
-- provider intent — every unit that did was taken off the reservation
-- at the moment it was spent. So the sweep can no longer give back
-- quota that a real follow already consumed, and the old question "does
-- an unresolved in-flight action exist?" is gone: it was the wrong
-- question, because a SUCCEEDED action has that marker cleared and
-- still spent a unit.

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
  for v_id in
    select r.id
      from public.bluesky_campaign_quota_reservations r
     where r.workspace_id = p_workspace_id
       and r.operator_account_id = p_operator_account_id
       and r.usage_date = p_usage_date
       and r.status = 'open'
       and r.expires_at < now()
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

revoke execute on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  to service_role;

-- =====================================================================
-- 3. Atomic reservation
-- =====================================================================
--
-- One transaction that: locks the identity-usage row and the run row,
-- sweeps lapsed reservations, computes the headroom that actually
-- remains from the RESERVATION ROWS, opens a reservation for what it
-- grants, and claims exactly that many members against it.
--
-- The locks are the point. `select ... for update` on both rows
-- serialises concurrent reservations against each other, so the read of
-- "how much is left" and the write of "I am taking this much" cannot be
-- interleaved by another session.
--
-- Lock ORDER is fixed — identity usage, then run — because a function
-- that sometimes takes them the other way round deadlocks when two
-- campaigns share an identity.
--
-- `reason` exists because "reserved 0" is three different situations
-- and the caller must distinguish them: a spent quota should finish the
-- run and schedule tomorrow, an empty queue should complete the
-- campaign, and a paused run should do neither.

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
  reservation_id uuid,
  reason text,
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
  delete from _claimed_members;

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
       -- And still unresolved, so there is something to find out.
       and exists (
         select 1
           from public.bluesky_relationship_actions a
          where a.campaign_member_id = c.id
            and a.status not in ('succeeded', 'failed', 'skipped')
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
  delete from _claimed_members;

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
$$;

revoke execute on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  to service_role;

-- Releasing members a worker did not use. The reservation itself is
-- settled separately — releasing rows does NOT release quota, because
-- the worker may still be mid-chunk with the rest of them.
create or replace function public.release_bluesky_campaign_members(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_member_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  update public.bluesky_follow_campaign_members
     set status = case
           when attempt_count > 0 then 'retryable'
           else 'queued'
         end,
         claimed_at = null,
         claimed_by = null,
         lease_expires_at = null,
         reservation_id = null
   where workspace_id = p_workspace_id
     and campaign_id = p_campaign_id
     and id = any(p_member_ids)
     and status in ('claimed', 'running');
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke execute on function public.release_bluesky_campaign_members(uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.release_bluesky_campaign_members(uuid, uuid, uuid[])
  to service_role;

-- =====================================================================
-- 4. Settlement — exactly once, from durable rows, and only your own
-- =====================================================================
--
-- Settlement no longer accepts the worker's chunk totals. It folds the
-- LEDGER, which is what the worker was writing as it went, so a chunk
-- that ended in a crash and a chunk that ended normally are recovered
-- by the same code path.
--
-- It also validates the whole tenant tuple. Checking only `run_id` left
-- a reservation from another workspace, campaign, identity or usage
-- date able to settle against this run — every one of those is a
-- different budget.

create or replace function public.apply_bluesky_run_outcome(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_run_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_reservation_id uuid,
  p_consecutive_failures integer,
  p_rate_limited_until timestamptz,
  p_rate_limit_remaining integer,
  p_rate_limit_reset_at timestamptz
)
returns table (
  settled boolean,
  already_settled boolean,
  refused_reason text,
  out_run_id uuid,
  out_attempted integer,
  out_succeeded integer,
  out_reserved integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.bluesky_identity_daily_usage;
  v_res public.bluesky_campaign_quota_reservations;
  v_run public.bluesky_follow_campaign_runs;
  v_run_reserved integer;
  v_identity_reserved integer;
begin
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
   where id = p_run_id and workspace_id = p_workspace_id
     for update;

  if v_run.id is null then
    settled := false; already_settled := false;
    refused_reason := 'unknown_run'; return next; return;
  end if;

  select * into v_res
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id
     for update;

  -- OWNERSHIP, in full. Each of these is a distinct budget, and a
  -- reservation that disagrees on any of them is not this run's to
  -- settle.
  if v_res.id is null then
    settled := false; already_settled := false;
    refused_reason := 'unknown_reservation';
  elsif v_res.workspace_id <> p_workspace_id then
    settled := false; already_settled := false;
    refused_reason := 'workspace_mismatch';
  elsif v_res.campaign_id <> p_campaign_id then
    settled := false; already_settled := false;
    refused_reason := 'campaign_mismatch';
  elsif v_res.run_id <> p_run_id then
    settled := false; already_settled := false;
    refused_reason := 'run_mismatch';
  elsif v_res.operator_account_id <> p_operator_account_id then
    settled := false; already_settled := false;
    refused_reason := 'identity_mismatch';
  elsif v_res.usage_date <> p_usage_date then
    settled := false; already_settled := false;
    refused_reason := 'usage_date_mismatch';
  elsif v_res.status = 'settled' then
    -- IDEMPOTENCE: a duplicate settlement applies nothing twice.
    settled := false; already_settled := true; refused_reason := null;
  end if;

  if refused_reason is not null or already_settled then
    out_run_id := v_run.id;
    out_attempted := v_run.attempted_count;
    out_succeeded := v_run.succeeded_count;
    out_reserved := v_run.reserved_count;
    return next; return;
  end if;

  -- Fold what actually happened, from the ledger. Idempotent per row.
  perform public.fold_bluesky_ledger_outcomes(p_reservation_id);

  -- Release whatever is LEFT: units that never reached provider intent.
  update public.bluesky_campaign_quota_reservations
     set status = 'settled', settled_at = now(), reserved_count = 0
   where id = v_res.id;

  update public.bluesky_follow_campaign_runs
     set consecutive_failures = greatest(coalesce(p_consecutive_failures, 0), 0),
         rate_limited_until = coalesce(p_rate_limited_until, rate_limited_until),
         rate_limit_remaining = coalesce(p_rate_limit_remaining, rate_limit_remaining),
         rate_limit_reset_at = coalesce(p_rate_limit_reset_at, rate_limit_reset_at),
         last_chunk_at = now(),
         status = case
           when p_rate_limited_until is not null then 'rate_limited'
           else status
         end
   where id = p_run_id;

  -- Caches recomputed from the rows that own the quota.
  select coalesce(sum(r.reserved_count), 0)::int into v_run_reserved
    from public.bluesky_campaign_quota_reservations r
   where r.run_id = p_run_id and r.status in ('open', 'held');

  select coalesce(sum(r.reserved_count), 0)::int into v_identity_reserved
    from public.bluesky_campaign_quota_reservations r
   where r.workspace_id = p_workspace_id
     and r.operator_account_id = p_operator_account_id
     and r.usage_date = p_usage_date
     and r.status in ('open', 'held');

  update public.bluesky_follow_campaign_runs
     set reserved_count = v_run_reserved where id = p_run_id;
  update public.bluesky_identity_daily_usage
     set reserved_count = v_identity_reserved where id = v_usage.id;

  select * into v_run
    from public.bluesky_follow_campaign_runs where id = p_run_id;

  settled := true; already_settled := false; refused_reason := null;
  out_run_id := v_run.id;
  out_attempted := v_run.attempted_count;
  out_succeeded := v_run.succeeded_count;
  out_reserved := v_run.reserved_count;
  return next;
end;
$$;

revoke execute on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, uuid, date, uuid, integer, timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, uuid, date, uuid, integer, timestamptz, integer, timestamptz)
  to service_role;

-- =====================================================================
-- 5. One dispatcher per campaign-day
-- =====================================================================
--
-- The reservation system bounds how much quota concurrent workers can
-- spend, but the consecutive-failure breaker is still a read-modify-
-- write across a whole dispatcher pass: worker A reads 3 failures,
-- worker B reads 3, both write 4, and a breaker set to trip at 5 never
-- trips even though eight consecutive follows failed.
--
-- Counting is not fixable by arithmetic here — "consecutive" is a
-- property of a SEQUENCE, and two interleaved workers do not have one.
-- So the pass is serialised per campaign-day with a lease on the run.
-- A lease rather than a lock because the holder is a serverless
-- function that can vanish without releasing anything.

alter table public.bluesky_follow_campaign_runs
  add column if not exists dispatch_lease_owner text,
  add column if not exists dispatch_lease_expires_at timestamptz;

create or replace function public.acquire_bluesky_run_dispatch_lease(
  p_workspace_id uuid,
  p_run_id uuid,
  p_owner text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean := false;
begin
  update public.bluesky_follow_campaign_runs
     set dispatch_lease_owner = p_owner,
         dispatch_lease_expires_at =
           now() + make_interval(
             secs => least(greatest(coalesce(p_lease_seconds, 60), 10), 3600))
   where id = p_run_id
     and workspace_id = p_workspace_id
     and (
       dispatch_lease_owner is null
       or dispatch_lease_owner = p_owner
       or dispatch_lease_expires_at is null
       or dispatch_lease_expires_at < now()
     );
  get diagnostics v_ok = row_count;
  return v_ok;
end;
$$;

create or replace function public.release_bluesky_run_dispatch_lease(
  p_workspace_id uuid,
  p_run_id uuid,
  p_owner text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bluesky_follow_campaign_runs
     set dispatch_lease_owner = null,
         dispatch_lease_expires_at = null
   where id = p_run_id
     and workspace_id = p_workspace_id
     and dispatch_lease_owner = p_owner;
end;
$$;

revoke execute on function public.acquire_bluesky_run_dispatch_lease(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_bluesky_run_dispatch_lease(uuid, uuid, text, integer)
  to service_role;
revoke execute on function public.release_bluesky_run_dispatch_lease(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_bluesky_run_dispatch_lease(uuid, uuid, text)
  to service_role;

-- =====================================================================
-- 6. Privileges for the new table
-- =====================================================================

grant select, insert, update, delete
  on public.bluesky_campaign_quota_reservations to service_role;

-- Reservations are operational state, not operator-editable. Members of
-- the workspace may read them; nobody writes them except the worker,
-- which is service_role and bypasses RLS.
drop policy if exists bluesky_quota_reservations_select
  on public.bluesky_campaign_quota_reservations;
create policy bluesky_quota_reservations_select
  on public.bluesky_campaign_quota_reservations
  for select
  using (public.is_workspace_member(workspace_id));
