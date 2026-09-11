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
-- 2. Reserved quota — OWNED, not inferred
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
  reserved_count integer not null check (reserved_count > 0),
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
-- 3. Reservation sweep — expiry that cannot silently free spent quota
-- =====================================================================
--
-- An open reservation whose lease lapsed belongs to a worker that is
-- gone. Its quota must come back or one crash permanently shrinks the
-- day. But it must NOT come back if a follow may already have been
-- sent under it: that follow reached a real person and consumed real
-- provider budget whether or not we recorded it.
--
-- So expiry splits in two:
--
--   held    — some member under this reservation has an action row
--             marked in-flight and not yet resolved. A createRecord may
--             have been issued. Quota stays consumed.
--   expired — no member under it could have reached the provider.
--             Quota returns.
--
-- A held reservation is released later, once reconciliation resolves
-- every action under it to a terminal state. Being wrong in this
-- direction costs a bounded under-count of attempts for one day; being
-- wrong in the other direction over-follows a real account.

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
  v_swept integer := 0;
begin
  -- Open, lapsed, and possibly mid-mutation → held.
  with lapsed as (
    select r.id
      from public.bluesky_campaign_quota_reservations r
     where r.workspace_id = p_workspace_id
       and r.operator_account_id = p_operator_account_id
       and r.usage_date = p_usage_date
       and r.status = 'open'
       and r.expires_at < now()
       for update
  ),
  classified as (
    select l.id,
           exists (
             select 1
               from public.bluesky_follow_campaign_members m
               join public.bluesky_relationship_actions a
                 on a.campaign_member_id = m.id
              where m.reservation_id = l.id
                and a.provider_in_flight_at is not null
                and a.status not in ('succeeded', 'failed', 'skipped')
           ) as maybe_mutated
      from lapsed l
  )
  update public.bluesky_campaign_quota_reservations r
     set status = case when c.maybe_mutated then 'held' else 'expired' end
    from classified c
   where r.id = c.id;
  get diagnostics v_swept = row_count;

  -- A held reservation whose actions have all resolved is no longer
  -- ambiguous, so its quota returns.
  update public.bluesky_campaign_quota_reservations r
     set status = 'expired'
   where r.workspace_id = p_workspace_id
     and r.operator_account_id = p_operator_account_id
     and r.usage_date = p_usage_date
     and r.status = 'held'
     and not exists (
       select 1
         from public.bluesky_follow_campaign_members m
         join public.bluesky_relationship_actions a
           on a.campaign_member_id = m.id
        where m.reservation_id = r.id
          and a.provider_in_flight_at is not null
          and a.status not in ('succeeded', 'failed', 'skipped')
     );

  return v_swept;
end;
$$;

revoke execute on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.sweep_bluesky_quota_reservations(uuid, uuid, date)
  to service_role;

-- =====================================================================
-- 4. Atomic reservation
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
  v_held public.bluesky_campaign_quota_reservations;
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
  -- A `held` reservation is quota kept consumed because a follow may
  -- have been issued under it. Its members must still be reconciled —
  -- but reconciliation reads relationship truth and can never send a
  -- mutation, so it consumes nothing and must not have to compete for
  -- headroom.
  --
  -- Requiring headroom here deadlocks exactly when it matters most: a
  -- campaign whose last unit of quota is held by a crashed worker has
  -- zero headroom, so it can never claim the member whose resolution
  -- would release that unit. The member sits `claimed` forever and the
  -- day never closes.
  --
  -- So the reconciliation pass TAKES OVER the held reservation: the
  -- same rows, the same quota, a fresh lease. Settling it is what
  -- finally releases the quota.
  select * into v_held
    from public.bluesky_campaign_quota_reservations
   where run_id = p_run_id
     and status = 'held'
   order by created_at
   for update skip locked
   limit 1;

  if v_held.id is not null then
    create temp table if not exists _claimed_members (
      id uuid, subject_did text, current_handle text,
      import_sequence bigint, attempt_count integer, provider_record_rkey text
    ) on commit drop;
    delete from _claimed_members;

    with picked as (
      select c.id
        from public.bluesky_follow_campaign_members c
       where c.reservation_id = v_held.id
         and c.status in ('claimed', 'running')
         and c.lease_expires_at is not null
         and c.lease_expires_at < now()
       order by c.import_sequence
       for update skip locked
    )
    insert into _claimed_members
    select m.id, m.subject_did, m.current_handle, m.import_sequence,
           m.attempt_count, m.provider_record_rkey
      from public.bluesky_follow_campaign_members m
     where m.id in (select id from picked);

    select count(*)::int into v_actual from _claimed_members;

    if v_actual > 0 then
      update public.bluesky_follow_campaign_members m
         set status = 'claimed',
             claimed_at = now(),
             claimed_by = p_claimed_by,
             lease_expires_at = now() + make_interval(secs => v_lease)
       where m.id in (select id from _claimed_members);

      update public.bluesky_campaign_quota_reservations
         set status = 'open',
             expires_at = now() + make_interval(secs => v_lease)
       where id = v_held.id;

      return query
      select v_actual, v_held.id, 'reconcile'::text, c.id, c.subject_did,
             c.current_handle, c.import_sequence, c.attempt_count,
             c.provider_record_rkey
        from _claimed_members c
       order by c.import_sequence;
      return;
    end if;
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

  -- `attempted_count` counts members that reached the provider path.
  -- `already_following_count` is NOT among them — that branch returns
  -- before an attempt is made — so subtracting it here would
  -- double-count and let the day overrun. Only `skipped_count` is an
  -- attempt that consumed no quota.
  v_run_headroom := greatest(
    0,
    v_run.effective_daily_quota
      - greatest(v_run.attempted_count - v_run.skipped_count, 0)
      - v_run_reserved
  );

  v_identity_headroom := greatest(
    0,
    coalesce(p_identity_ceiling, 0)
      - v_usage.follows_created
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
-- 5. Settlement — exactly once, and only of your own reservation
-- =====================================================================
--
-- Settlement validates OWNERSHIP before it applies anything. The
-- previous version took a scalar `consumeReservation` count and
-- subtracted it from whatever `reserved_count` happened to hold, which
-- is how worker A could consume worker B's reservation.
--
-- Counters are deltas. Writing absolutes computed from a snapshot read
-- at the top of a dispatcher pass loses every concurrent increment.

create or replace function public.apply_bluesky_run_outcome(
  p_workspace_id uuid,
  p_run_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_reservation_id uuid,
  p_attempted integer,
  p_succeeded integer,
  p_already_following integer,
  p_skipped integer,
  p_failed integer,
  p_records_created integer,
  p_consecutive_failures integer,
  p_rate_limited_until timestamptz,
  p_rate_limit_remaining integer,
  p_rate_limit_reset_at timestamptz
)
-- Deliberately NOT named after the columns they report. An OUT
-- parameter called `attempted_count` shadows the column of the same
-- name inside `update … set attempted_count = attempted_count + …`,
-- which plpgsql rejects as ambiguous at RUNTIME — the function creates
-- cleanly and fails the first time it is called.
returns table (
  settled boolean,
  already_settled boolean,
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
  -- Same lock order as the reservation path.
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
    settled := false; already_settled := false; return next; return;
  end if;

  select * into v_res
    from public.bluesky_campaign_quota_reservations
   where id = p_reservation_id
     for update;

  -- OWNERSHIP. A reservation belonging to another run, another
  -- workspace, or to nothing at all settles nothing. This is what stops
  -- a late worker consuming a reservation that is not its own.
  if v_res.id is null
     or v_res.run_id <> p_run_id
     or v_res.workspace_id <> p_workspace_id then
    settled := false; already_settled := false;
    out_run_id := v_run.id;
    out_attempted := v_run.attempted_count;
    out_succeeded := v_run.succeeded_count;
    out_reserved := v_run.reserved_count;
    return next; return;
  end if;

  -- IDEMPOTENCE. A duplicate settlement applies nothing a second time.
  -- Both halves matter: the deltas must not be double-counted, and the
  -- quota must not be released twice.
  if v_res.status = 'settled' then
    settled := false; already_settled := true;
    out_run_id := v_run.id;
    out_attempted := v_run.attempted_count;
    out_succeeded := v_run.succeeded_count;
    out_reserved := v_run.reserved_count;
    return next; return;
  end if;

  -- A reservation swept to `held` or `expired` still settles: the
  -- attempts under it really happened and must be counted. Marking it
  -- settled is what releases its quota, and it can only happen once.
  update public.bluesky_campaign_quota_reservations
     set status = 'settled', settled_at = now()
   where id = v_res.id;

  update public.bluesky_follow_campaign_runs
     set attempted_count = attempted_count + greatest(coalesce(p_attempted, 0), 0),
         succeeded_count = succeeded_count + greatest(coalesce(p_succeeded, 0), 0),
         already_following_count = already_following_count
           + greatest(coalesce(p_already_following, 0), 0),
         skipped_count = skipped_count + greatest(coalesce(p_skipped, 0), 0),
         failed_count = failed_count + greatest(coalesce(p_failed, 0), 0),
         consecutive_failures = greatest(coalesce(p_consecutive_failures, 0), 0),
         rate_limited_until = coalesce(p_rate_limited_until, rate_limited_until),
         rate_limit_remaining = coalesce(p_rate_limit_remaining, rate_limit_remaining),
         rate_limit_reset_at = coalesce(p_rate_limit_reset_at, rate_limit_reset_at),
         last_chunk_at = now(),
         status = case
           when p_rate_limited_until is not null then 'rate_limited'
           else status
         end
   where id = p_run_id;

  update public.bluesky_identity_daily_usage
     set follows_created = follows_created + greatest(coalesce(p_records_created, 0), 0),
         attempts_made = attempts_made + greatest(coalesce(p_attempted, 0), 0),
         updated_at = now()
   where id = v_usage.id;

  -- Refresh the caches from the rows that own the quota.
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

  settled := true;
  already_settled := false;
  out_run_id := v_run.id;
  out_attempted := v_run.attempted_count;
  out_succeeded := v_run.succeeded_count;
  out_reserved := v_run.reserved_count;
  return next;
end;
$$;

revoke execute on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, uuid, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_bluesky_run_outcome(
  uuid, uuid, uuid, date, uuid, integer, integer, integer, integer,
  integer, integer, integer, timestamptz, integer, timestamptz)
  to service_role;

-- =====================================================================
-- 5b. One dispatcher per campaign-day
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
    'bluesky_campaign_quota_reservations',
    'bluesky_relationship_actions'
  ] loop
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

-- Reservations are operational state, not operator-editable. Members of
-- the workspace may read them (they appear in run diagnostics); nobody
-- writes them except the worker, which is service_role and bypasses RLS.
drop policy if exists bluesky_quota_reservations_select
  on public.bluesky_campaign_quota_reservations;
create policy bluesky_quota_reservations_select
  on public.bluesky_campaign_quota_reservations
  for select
  using (public.is_workspace_member(workspace_id));
