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
-- 2. Reservation sweep — expiry that cannot silently free spent quota
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
-- 4. Settlement — exactly once, and only of your own reservation
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
