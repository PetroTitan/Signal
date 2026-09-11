-- Bluesky Follow Campaigns — durable queue, daily runs, atomic claiming.
--
-- Strictly ADDITIVE and forward-only. No existing table is dropped or
-- rewritten; the only change to an existing table is three NULLABLE
-- columns on bluesky_relationship_actions so a campaign follow lands in
-- the audit trail that already exists, with its existing invariants
-- (the one-active-action index, the frozen-batch trigger) untouched.
--
-- Every statement is idempotent: `if not exists` on tables and indexes,
-- `drop ... if exists` before every trigger and policy, `create or
-- replace` for functions, `add column if not exists`.
--
-- WHY A CLAIMING RPC
-- ------------------
-- PostgREST cannot express `FOR UPDATE SKIP LOCKED`, and claiming N
-- rows with N guarded UPDATEs costs N round trips and still races on
-- selection. At 100,000 members that is the difference between a
-- constant-time claim and a linear scan. plpgsql + SECURITY DEFINER are
-- already used by five migrations in this repository, so this is in
-- convention rather than a new mechanism.

set search_path = public;

-- =====================================================================
-- 1. Campaigns
-- =====================================================================

create table if not exists public.bluesky_follow_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The identity whose Bluesky session performs every follow. Named to
  -- match the existing relationship tables' `operator_account_id`.
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,

  name text not null check (length(btrim(name)) between 1 and 120),

  status text not null default 'draft' check (status in (
    'draft',                      -- configured, never activated
    'active',                     -- running on its schedule
    'paused',                     -- operator stopped it; resumable
    'completed',                  -- every eligible member is terminal
    'reauthorization_required',   -- 401; needs the operator to reconnect
    'rate_limited',               -- provider 429; resumes after reset
    'failed',                     -- structural provider failure
    'cancelled'                   -- operator ended it; not resumable
  )),

  -- What the operator asked for. The SERVER computes what is actually
  -- attempted (see bluesky_follow_campaign_runs.effective_daily_quota);
  -- this value is never used directly as an attempt budget.
  requested_daily_quota integer not null default 100
    check (requested_daily_quota in (100, 200, 400, 600, 800, 1000)),

  -- IANA zone. The campaign's "day" is the local calendar date here,
  -- which is what makes a daily quota mean what an operator expects
  -- across DST transitions.
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),

  -- Local wall-clock window, minutes from local midnight. Minutes
  -- rather than a time: a local time on a spring-forward day may not
  -- exist, and minutes-from-midnight compares cleanly against the
  -- observed local time without reconstructing a timestamp.
  execution_window_start_minute integer not null default 540
    check (execution_window_start_minute between 0 and 1439),
  execution_window_end_minute integer not null default 1200
    check (execution_window_end_minute between 1 and 1440),

  start_date date,

  -- Dry run performs every step EXCEPT the provider mutation.
  dry_run boolean not null default false,

  -- Circuit breakers. Operator-configurable, with safe defaults.
  max_consecutive_failures integer not null default 5
    check (max_consecutive_failures between 1 and 100),
  min_success_rate_percent integer not null default 50
    check (min_success_rate_percent between 0 and 100),

  next_run_at timestamptz,
  activated_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  cancelled_at timestamptz,

  last_error_code text,
  last_error_message text,
  -- When a 429 told us when it is safe to resume.
  rate_limited_until timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A window must be a real interval.
  constraint bluesky_campaigns_window_ordered
    check (execution_window_end_minute > execution_window_start_minute)
);

comment on table public.bluesky_follow_campaigns is
  'An operator-approved, autonomously-processed follow queue. The '
  'requested quota is what the operator chose; what Signal may actually '
  'attempt is computed per run and is often lower.';

comment on column public.bluesky_follow_campaigns.requested_daily_quota is
  'Operator intent only. Never an attempt budget: the effective quota is '
  'computed per run from the identity''s remaining allowance, circuit '
  'breakers and provider rate-limit state.';

create index if not exists bluesky_campaigns_ws_status_idx
  on public.bluesky_follow_campaigns (workspace_id, status);

-- The dispatcher's hot path: active campaigns that are due. Partial, so
-- it stays small however many completed campaigns accumulate.
create index if not exists bluesky_campaigns_due_idx
  on public.bluesky_follow_campaigns (next_run_at)
  where status = 'active';

create index if not exists bluesky_campaigns_identity_idx
  on public.bluesky_follow_campaigns (workspace_id, operator_account_id);

drop trigger if exists bluesky_follow_campaigns_touch
  on public.bluesky_follow_campaigns;
create trigger bluesky_follow_campaigns_touch
  before update on public.bluesky_follow_campaigns
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2. Members — the durable queue
-- =====================================================================
--
-- Designed for 100,000+ rows per campaign. Nothing reads the whole
-- table: the worker claims a bounded chunk by import_sequence, and the
-- UI pages by the same key.

create table if not exists public.bluesky_follow_campaign_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null
    references public.bluesky_follow_campaigns(id) on delete cascade,

  -- DID is identity, exactly as in the relationship tables. There is no
  -- unique index on a handle anywhere: the provider returns
  -- `handle.invalid` as a real value, so a handle is not even
  -- guaranteed well-formed.
  actor_did text not null check (actor_did like 'did:%'),
  current_handle text,
  display_name text,

  -- BIGINT: the ordering key for a queue with no application-level
  -- maximum. Assigned at import in a single monotonic sequence per
  -- campaign, so ordering is stable and keyset claiming needs no OFFSET.
  import_sequence bigint not null,

  status text not null default 'queued' check (status in (
    'queued',
    'claimed',            -- leased to a worker; recoverable on expiry
    'running',            -- provider call in flight
    'succeeded',
    'already_following',  -- observed, consumes no quota
    'protected',          -- excluded by operator protection
    'skipped',
    'retryable',          -- transient failure, will be re-claimed
    'failed_structural',  -- terminal; will not be retried
    'cancelled'
  )),

  attempt_count integer not null default 0,
  next_attempt_at timestamptz,

  -- Lease. A worker that dies leaves a claim that expires and returns
  -- to the queue; safe here because the worker reads relationship truth
  -- before re-attempting.
  claimed_at timestamptz,
  claimed_by text,
  lease_expires_at timestamptz,

  -- Provider record identity, captured from createRecord. Never derived
  -- from the DID — observed rkeys use incompatible schemes.
  provider_record_uri text,
  provider_record_rkey text,
  provider_record_cid text,

  last_error_code text,
  last_error_message text,
  last_attempted_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per DID per campaign. A DID imported from five sources is
  -- ONE member with five rows in bluesky_campaign_member_sources.
  unique (campaign_id, actor_did),
  -- Stable ordering key, unique within the campaign.
  unique (campaign_id, import_sequence)
);

comment on table public.bluesky_follow_campaign_members is
  'The durable queue. Keyed by DID; ordered by a per-campaign BIGINT '
  'import_sequence so claiming is keyset-based and costs the same at '
  'row 1 and row 100,000.';

-- THE claiming index. Partial on the claimable statuses so it stays
-- proportional to outstanding work rather than to queue size, and
-- ordered by import_sequence so the RPC's ORDER BY is an index scan.
create index if not exists bluesky_campaign_members_claimable_idx
  on public.bluesky_follow_campaign_members
     (campaign_id, import_sequence)
  where status in ('queued', 'retryable');

-- Lease recovery: find expired claims cheaply.
create index if not exists bluesky_campaign_members_lease_idx
  on public.bluesky_follow_campaign_members (lease_expires_at)
  where status in ('claimed', 'running');

-- UI paging and exact counts per status.
create index if not exists bluesky_campaign_members_status_idx
  on public.bluesky_follow_campaign_members
     (campaign_id, status, import_sequence);

create index if not exists bluesky_campaign_members_ws_idx
  on public.bluesky_follow_campaign_members (workspace_id, campaign_id);

-- Finding a person across campaigns (and the per-identity guard).
create index if not exists bluesky_campaign_members_did_idx
  on public.bluesky_follow_campaign_members (workspace_id, actor_did);

drop trigger if exists bluesky_campaign_members_touch
  on public.bluesky_follow_campaign_members;
create trigger bluesky_campaign_members_touch
  before update on public.bluesky_follow_campaign_members
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 3. Member source attribution
-- =====================================================================
--
-- A join table rather than an array column, for the same reason as
-- bluesky_candidate_sources: an array is read-modify-written, and two
-- concurrent imports of overlapping audiences lose one attribution.

create table if not exists public.bluesky_campaign_member_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  member_id uuid not null
    references public.bluesky_follow_campaign_members(id) on delete cascade,

  -- Where this DID came from. A target profile when imported from one;
  -- otherwise a free-form label ('manual', 'candidate_filter').
  target_profile_id uuid
    references public.bluesky_target_profiles(id) on delete set null,
  source_label text not null default 'import',

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen integer not null default 1,
  created_at timestamptz not null default now(),

  unique (member_id, target_profile_id, source_label)
);

create index if not exists bluesky_campaign_member_sources_member_idx
  on public.bluesky_campaign_member_sources (member_id);

create index if not exists bluesky_campaign_member_sources_target_idx
  on public.bluesky_campaign_member_sources (target_profile_id);

-- =====================================================================
-- 4. Daily runs — the cron idempotency boundary
-- =====================================================================

create table if not exists public.bluesky_follow_campaign_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null
    references public.bluesky_follow_campaigns(id) on delete cascade,

  -- The campaign's LOCAL calendar date, computed in its timezone. This
  -- is what "a day" means for a daily quota, and with the unique index
  -- below it is also the idempotency key: Vercel Cron is at-least-once,
  -- so a duplicate delivery must find this run rather than create one.
  local_date date not null,

  status text not null default 'running' check (status in (
    'running', 'completed', 'paused', 'rate_limited', 'failed', 'cancelled'
  )),

  requested_daily_quota integer not null,
  -- Computed by the SERVER at run creation and re-evaluated per chunk.
  -- Always <= requested.
  effective_daily_quota integer not null,
  -- Why it is lower, when it is. Operator-facing.
  effective_quota_reason text,

  attempted_count integer not null default 0,
  succeeded_count integer not null default 0,
  already_following_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,

  -- Consecutive failures within this run, for the circuit breaker.
  consecutive_failures integer not null default 0,

  rate_limited_until timestamptz,
  rate_limit_remaining integer,
  rate_limit_reset_at timestamptz,

  last_error_code text,
  last_error_message text,

  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_chunk_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE run per campaign per local day. This is the whole defence
  -- against duplicate cron delivery.
  unique (campaign_id, local_date),

  constraint bluesky_campaign_runs_effective_lte_requested
    check (effective_daily_quota <= requested_daily_quota)
);

comment on constraint bluesky_campaign_runs_effective_lte_requested
  on public.bluesky_follow_campaign_runs is
  'The effective quota can never exceed what the operator requested. A '
  'bug that widened it would have Signal attempting more than was '
  'approved, so the database refuses it.';

comment on index public.bluesky_follow_campaign_runs_campaign_id_local_date_key is
  'Vercel Cron delivers at-least-once. This unique index is what makes a '
  'duplicate delivery find the day''s run instead of starting a second.';

create index if not exists bluesky_campaign_runs_campaign_idx
  on public.bluesky_follow_campaign_runs (campaign_id, local_date desc);

create index if not exists bluesky_campaign_runs_ws_status_idx
  on public.bluesky_follow_campaign_runs (workspace_id, status);

drop trigger if exists bluesky_campaign_runs_touch
  on public.bluesky_follow_campaign_runs;
create trigger bluesky_campaign_runs_touch
  before update on public.bluesky_follow_campaign_runs
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 5. Per-identity daily usage
-- =====================================================================
--
-- Two campaigns may share an acting identity. Bluesky's limits are per
-- ACCOUNT, not per campaign, so the allowance has to be tracked where
-- the account is.

create table if not exists public.bluesky_identity_daily_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_account_id uuid not null
    references public.growth_accounts(id) on delete cascade,
  -- UTC date. Deliberately NOT a campaign-local date: the provider's
  -- budget is not aware of any campaign's timezone.
  usage_date date not null,

  -- Records actually created. This is what Bluesky counts (3 points per
  -- CREATE against 35,000 points/day).
  follows_created integer not null default 0,
  -- Attempts that reached the provider, successful or not.
  attempts_made integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, operator_account_id, usage_date)
);

comment on table public.bluesky_identity_daily_usage is
  'Per-account daily consumption. Bluesky''s documented budget (35,000 '
  'points/day, 3 per CREATE) is per DID, so two campaigns sharing an '
  'identity share this row.';

create index if not exists bluesky_identity_usage_lookup_idx
  on public.bluesky_identity_daily_usage
     (workspace_id, operator_account_id, usage_date desc);

drop trigger if exists bluesky_identity_daily_usage_touch
  on public.bluesky_identity_daily_usage;
create trigger bluesky_identity_daily_usage_touch
  before update on public.bluesky_identity_daily_usage
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 6. Kill switches
-- =====================================================================
--
-- A row-based switch rather than only an env var, so an operator can
-- stop everything without a redeploy. The env var remains as a
-- deploy-level override (see the runbook).

create table if not exists public.bluesky_campaign_kill_switches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- NULL = the workspace-global switch. Non-null = that identity only.
  operator_account_id uuid
    references public.growth_accounts(id) on delete cascade,

  engaged boolean not null default true,
  reason text,
  engaged_by uuid references auth.users(id) on delete set null,
  engaged_at timestamptz not null default now(),
  released_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One global switch row per workspace, and one per identity.
create unique index if not exists bluesky_kill_switch_global_idx
  on public.bluesky_campaign_kill_switches (workspace_id)
  where operator_account_id is null;

create unique index if not exists bluesky_kill_switch_identity_idx
  on public.bluesky_campaign_kill_switches (workspace_id, operator_account_id)
  where operator_account_id is not null;

drop trigger if exists bluesky_kill_switches_touch
  on public.bluesky_campaign_kill_switches;
create trigger bluesky_kill_switches_touch
  before update on public.bluesky_campaign_kill_switches
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 7. Link campaign work into the EXISTING audit trail
-- =====================================================================
--
-- Nullable, so every existing row stays valid and every existing
-- invariant on this table (the one-active-action partial unique index,
-- the frozen-batch trigger) is untouched. A campaign follow is a
-- relationship action like any other; it simply also knows which
-- campaign asked for it.

alter table public.bluesky_relationship_actions
  add column if not exists campaign_id uuid
    references public.bluesky_follow_campaigns(id) on delete set null,
  add column if not exists campaign_run_id uuid
    references public.bluesky_follow_campaign_runs(id) on delete set null,
  add column if not exists campaign_member_id uuid
    references public.bluesky_follow_campaign_members(id) on delete set null;

comment on column public.bluesky_relationship_actions.campaign_id is
  'Set when this action was performed by a follow campaign. Null for '
  'the manual Follow/Unfollow workflows, which are unchanged.';

create index if not exists bluesky_relationship_actions_campaign_idx
  on public.bluesky_relationship_actions (campaign_id, requested_at desc)
  where campaign_id is not null;

create index if not exists bluesky_relationship_actions_campaign_run_idx
  on public.bluesky_relationship_actions (campaign_run_id)
  where campaign_run_id is not null;

-- The campaign's own idempotency key, independent of the existing
-- one-active-action index: at most ONE non-cancelled action per
-- (campaign, member). A duplicate cron delivery, a re-claimed lease and
-- a retried chunk all collide here rather than creating a second follow.
create unique index if not exists bluesky_relationship_actions_campaign_member_idx
  on public.bluesky_relationship_actions (campaign_id, campaign_member_id)
  where campaign_id is not null
    and campaign_member_id is not null
    and status <> 'skipped';

comment on index public.bluesky_relationship_actions_campaign_member_idx is
  'One action per (campaign, member). createRecord is not idempotent, so '
  'this is the database-level guarantee that a member cannot be followed '
  'twice however many times a worker or cron delivery repeats.';

-- =====================================================================
-- 8. Atomic chunk claiming
-- =====================================================================
--
-- The one thing application code cannot do correctly on its own.
--
-- `for update skip locked` is what makes two concurrent workers unable
-- to claim the same member: the second worker's select simply does not
-- see the rows the first has locked, so it takes the next ones instead
-- of blocking or racing. A check-then-update in application code has a
-- window between the two statements; this has none.
--
-- Ordering is by import_sequence, which has a partial index on exactly
-- the claimable statuses — so claiming the 100,000th member costs what
-- claiming the first did. There is NO OFFSET: offset-based claiming
-- degrades linearly and, worse, silently skips rows when earlier ones
-- change status between calls.
--
-- Expired leases are reclaimed by the same statement. That is safe for
-- follows (the worker reads relationship truth before re-attempting)
-- in a way it is not for publishing, whose stale-claim recovery is
-- deliberately manual.
--
-- SECURITY DEFINER with an explicit workspace argument: the function is
-- called by the service-role worker, which has no RLS context, so the
-- workspace filter is an argument that is always applied rather than a
-- policy that would not fire.

create or replace function public.claim_bluesky_campaign_members(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_chunk_size integer,
  p_lease_seconds integer,
  p_claimed_by text
)
returns setof public.bluesky_follow_campaign_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chunk integer := least(greatest(coalesce(p_chunk_size, 1), 1), 100);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 60), 10), 3600);
begin
  return query
  update public.bluesky_follow_campaign_members m
     set status = 'claimed',
         claimed_at = now(),
         claimed_by = p_claimed_by,
         lease_expires_at = now() + make_interval(secs => v_lease)
   where m.id in (
     select c.id
       from public.bluesky_follow_campaign_members c
      where c.workspace_id = p_workspace_id
        and c.campaign_id = p_campaign_id
        and (
          -- Never attempted, or awaiting a bounded retry.
          (c.status in ('queued', 'retryable')
             and (c.next_attempt_at is null or c.next_attempt_at <= now()))
          -- Or a lease that expired because its worker died.
          or (c.status in ('claimed', 'running')
             and c.lease_expires_at is not null
             and c.lease_expires_at < now())
        )
      order by c.import_sequence
      for update skip locked
      limit v_chunk
   )
  returning m.*;
end;
$$;

comment on function public.claim_bluesky_campaign_members is
  'Atomically lease up to N queue members. FOR UPDATE SKIP LOCKED is '
  'what prevents two workers claiming the same DID — not application '
  'logic. Keyset order by import_sequence with a partial index, never '
  'OFFSET, so the cost does not grow with queue position.';

revoke all on function public.claim_bluesky_campaign_members(
  uuid, uuid, integer, integer, text) from public;
revoke all on function public.claim_bluesky_campaign_members(
  uuid, uuid, integer, integer, text) from anon;
revoke all on function public.claim_bluesky_campaign_members(
  uuid, uuid, integer, integer, text) from authenticated;

-- Release a claim without consuming an attempt.
--
-- Used when a chunk stops early (quota reached, rate limit, kill
-- switch): rows that were leased but never touched must go back to the
-- queue immediately rather than waiting out their lease, and must NOT
-- have their attempt_count incremented — they were never attempted.
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
  v_count integer;
begin
  update public.bluesky_follow_campaign_members m
     set status = 'queued',
         claimed_at = null,
         claimed_by = null,
         lease_expires_at = null
   where m.workspace_id = p_workspace_id
     and m.campaign_id = p_campaign_id
     and m.id = any(p_member_ids)
     -- Only rows that never progressed past the lease.
     and m.status in ('claimed', 'running');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.release_bluesky_campaign_members is
  'Return untouched leased rows to the queue without consuming an '
  'attempt. A row that was never sent to the provider must not be '
  'penalised for a chunk that stopped early.';

revoke all on function public.release_bluesky_campaign_members(
  uuid, uuid, uuid[]) from public;
revoke all on function public.release_bluesky_campaign_members(
  uuid, uuid, uuid[]) from anon;
revoke all on function public.release_bluesky_campaign_members(
  uuid, uuid, uuid[]) from authenticated;

-- Get-or-create the day's run, atomically.
--
-- Vercel Cron is at-least-once. Two deliveries arriving together would
-- both see "no run for today" and both insert; the unique index turns
-- the loser into a conflict, and ON CONFLICT DO NOTHING + re-select
-- turns that into "found the existing one" rather than an error.
create or replace function public.ensure_bluesky_campaign_run(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_local_date date,
  p_requested_quota integer,
  p_effective_quota integer,
  p_effective_reason text
)
returns public.bluesky_follow_campaign_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.bluesky_follow_campaign_runs;
begin
  insert into public.bluesky_follow_campaign_runs (
    workspace_id, campaign_id, local_date, status,
    requested_daily_quota, effective_daily_quota, effective_quota_reason
  )
  values (
    p_workspace_id, p_campaign_id, p_local_date, 'running',
    p_requested_quota, least(p_effective_quota, p_requested_quota), p_effective_reason
  )
  on conflict (campaign_id, local_date) do nothing
  returning * into v_run;

  if v_run.id is null then
    select * into v_run
      from public.bluesky_follow_campaign_runs
     where campaign_id = p_campaign_id
       and local_date = p_local_date;
  end if;

  return v_run;
end;
$$;

comment on function public.ensure_bluesky_campaign_run is
  'Idempotent daily-run creation. Two simultaneous cron deliveries both '
  'reach the unique index; the loser re-selects the winner''s row '
  'instead of erroring or creating a second run.';

revoke all on function public.ensure_bluesky_campaign_run(
  uuid, uuid, date, integer, integer, text) from public;
revoke all on function public.ensure_bluesky_campaign_run(
  uuid, uuid, date, integer, integer, text) from anon;
revoke all on function public.ensure_bluesky_campaign_run(
  uuid, uuid, date, integer, integer, text) from authenticated;

-- Per-identity usage accounting, atomic.
create or replace function public.record_bluesky_identity_usage(
  p_workspace_id uuid,
  p_operator_account_id uuid,
  p_usage_date date,
  p_follows_created integer,
  p_attempts_made integer
)
returns public.bluesky_identity_daily_usage
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.bluesky_identity_daily_usage;
begin
  insert into public.bluesky_identity_daily_usage (
    workspace_id, operator_account_id, usage_date, follows_created, attempts_made
  )
  values (
    p_workspace_id, p_operator_account_id, p_usage_date,
    greatest(coalesce(p_follows_created, 0), 0),
    greatest(coalesce(p_attempts_made, 0), 0)
  )
  on conflict (workspace_id, operator_account_id, usage_date)
  do update set
    follows_created = public.bluesky_identity_daily_usage.follows_created
      + greatest(coalesce(p_follows_created, 0), 0),
    attempts_made = public.bluesky_identity_daily_usage.attempts_made
      + greatest(coalesce(p_attempts_made, 0), 0)
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.record_bluesky_identity_usage is
  'Atomic per-account daily accounting. An increment rather than a '
  'read-modify-write, so two campaigns sharing an identity cannot lose '
  'each other''s consumption.';

revoke all on function public.record_bluesky_identity_usage(
  uuid, uuid, date, integer, integer) from public;
revoke all on function public.record_bluesky_identity_usage(
  uuid, uuid, date, integer, integer) from anon;
revoke all on function public.record_bluesky_identity_usage(
  uuid, uuid, date, integer, integer) from authenticated;

-- =====================================================================
-- 9. RLS — every new table, same workspace-member pattern
-- =====================================================================
--
-- Members of the workspace may READ everything and may INSERT/UPDATE
-- configuration. Note what RLS does NOT do here: it does not decide who
-- may activate a campaign or change a quota. That is a
-- `connect_platforms` permission check in the server action, because
-- RLS sees membership and not role. Client visibility is never the
-- boundary.
--
-- The worker runs as the service role and bypasses these policies
-- entirely, which is exactly why every worker query also filters on
-- workspace_id explicitly.

alter table public.bluesky_follow_campaigns enable row level security;
alter table public.bluesky_follow_campaign_members enable row level security;
alter table public.bluesky_campaign_member_sources enable row level security;
alter table public.bluesky_follow_campaign_runs enable row level security;
alter table public.bluesky_identity_daily_usage enable row level security;
alter table public.bluesky_campaign_kill_switches enable row level security;

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
    execute format('drop policy if exists %I on public.%I', t || ': members read', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_workspace_member(workspace_id))',
      t || ': members read', t);

    execute format('drop policy if exists %I on public.%I', t || ': members insert', t);
    execute format(
      'create policy %I on public.%I for insert with check (public.is_workspace_member(workspace_id))',
      t || ': members insert', t);

    execute format('drop policy if exists %I on public.%I', t || ': members update', t);
    execute format(
      'create policy %I on public.%I for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      t || ': members update', t);
  end loop;
end;
$$;

-- Deletes.
--
-- A draft campaign and its queue may be removed; a run may not, because
-- it is the record of what was attempted. No DELETE policy exists on
-- bluesky_follow_campaign_runs or on the relationship action table —
-- history is not deletable through the API.
drop policy if exists "bluesky_follow_campaigns: members delete"
  on public.bluesky_follow_campaigns;
create policy "bluesky_follow_campaigns: members delete"
  on public.bluesky_follow_campaigns for delete
  using (public.is_workspace_member(workspace_id) and status = 'draft');

drop policy if exists "bluesky_follow_campaign_members: members delete"
  on public.bluesky_follow_campaign_members;
create policy "bluesky_follow_campaign_members: members delete"
  on public.bluesky_follow_campaign_members for delete
  using (public.is_workspace_member(workspace_id));

drop policy if exists "bluesky_campaign_member_sources: members delete"
  on public.bluesky_campaign_member_sources;
create policy "bluesky_campaign_member_sources: members delete"
  on public.bluesky_campaign_member_sources for delete
  using (public.is_workspace_member(workspace_id));

drop policy if exists "bluesky_campaign_kill_switches: members delete"
  on public.bluesky_campaign_kill_switches;
create policy "bluesky_campaign_kill_switches: members delete"
  on public.bluesky_campaign_kill_switches for delete
  using (public.is_workspace_member(workspace_id));
