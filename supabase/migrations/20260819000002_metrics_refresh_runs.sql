-- Canonical refresh-run record.
--
-- WHY THIS TABLE EXISTS
-- --------------------
-- The previous milestone made the sweep explain itself in its HTTP
-- response and in a stdout log line, and wrote a per-workspace summary to
-- activity_events. That left one state unrecorded, and it happened to be
-- the important one: activity_events rows are written per workspace, and
-- workspaces are derived from the run's CANDIDATES. A run that found no
-- candidates — or whose loaders threw, which also yields no candidates —
-- wrote nothing at all.
--
-- So three distinct outcomes shared one indistinguishable absence:
--
--     the sweep never ran
--     the sweep ran and found nothing
--     the sweep ran and its database queries failed
--
-- This table records one row per run, unconditionally, whatever happened.
-- "Never run" now means literally zero rows, and every other state carries
-- its own reason.
--
-- ISOLATION NOTE
-- --------------
-- A sweep spans every workspace, so a run is not workspace-owned and this
-- table deliberately has NO workspace_id. It holds only counters,
-- timings, provider names and a diagnosis sentence — no workspace
-- identifiers, no post identifiers, no content. Per-workspace detail
-- stays in activity_events, which is properly RLS-scoped. An invariant
-- test asserts no UUID is ever written into the columns here.
--
-- Reads are limited to people who are a member of at least one workspace,
-- i.e. actual Signal operators, rather than any authenticated principal.
--
-- Additive. No existing table is altered.

set search_path = public;

create table if not exists public.metrics_refresh_runs (
  id uuid primary key default gen_random_uuid(),

  -- Correlates this row with the stdout log line and the HTTP response.
  run_id text not null unique,

  -- What kind of run this was. The scheduled sweep and an operator's
  -- manual trigger have very different meanings when reading history.
  trigger text not null default 'cron'
    check (trigger in ('cron', 'manual', 'backfill', 'smoke_test')),

  phase text not null
    check (phase in ('started', 'completed', 'failed')),

  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,

  -- Scope of the run.
  workspace_count integer not null default 0,
  seed_window_days integer,

  -- Candidate funnel. Each stage is separate so a drop-off is locatable
  -- rather than inferred.
  publication_candidates integer not null default 0,
  eligible_posts integer not null default 0,
  provider_reads_attempted integer not null default 0,
  provider_reads_succeeded integer not null default 0,
  provider_reads_failed integer not null default 0,

  -- Persistence outcomes.
  snapshots_written integer not null default 0,
  snapshots_skipped_duplicate integer not null default 0,

  -- Non-success classifications, kept apart because they need opposite
  -- operator responses.
  rate_limited_count integer not null default 0,
  unavailable_count integer not null default 0,
  unsupported_count integer not null default 0,
  stale_count integer not null default 0,
  provider_error_count integer not null default 0,
  skipped_count integer not null default 0,

  -- Account-context collection, which shares the sweep's orchestration.
  account_snapshots_attempted integer not null default 0,
  account_snapshots_written integer not null default 0,
  account_snapshots_failed integer not null default 0,

  -- Per-provider breakdown: { "bluesky": { attempted, succeeded, ... } }.
  -- Provider names and counters only.
  by_provider jsonb not null default '{}'::jsonb,

  -- Why a run measured nothing. NULL when it measured something.
  -- No ambiguous zero: a run with zero reads must name its reason.
  zero_reason text
    check (zero_reason is null or zero_reason in (
      'zero_candidates',
      'all_outside_window',
      'all_already_fresh',
      'all_skipped_no_identifier',
      'provider_unavailable',
      'workspace_query_failed',
      'credentials_missing',
      'rate_limited',
      'fatal_error'
    )),

  -- Redacted before storage; never a raw provider body.
  fatal_error text,
  diagnosis text not null,

  created_at timestamptz not null default now()
);

comment on table public.metrics_refresh_runs is
  'One row per metrics refresh run, written unconditionally. Zero rows '
  'means the sweep has genuinely never run. Contains no workspace or post '
  'identifiers — per-workspace detail lives in activity_events.';
comment on column public.metrics_refresh_runs.zero_reason is
  'Why a run measured nothing. Never null when provider_reads_succeeded '
  'is 0 — an unexplained zero is the bug this table exists to prevent.';

create index if not exists metrics_refresh_runs_started_idx
  on public.metrics_refresh_runs (started_at desc);

-- The health evaluator asks "when did a run last SUCCEED", which is a
-- different question from "when did one last happen".
create index if not exists metrics_refresh_runs_success_idx
  on public.metrics_refresh_runs (started_at desc)
  where phase = 'completed' and provider_reads_succeeded > 0;

alter table public.metrics_refresh_runs enable row level security;

-- Readable by Signal operators (members of at least one workspace).
-- Writes are service-role only: the sweep runs as the system, and no
-- cookie-session client should be able to forge a run record.
drop policy if exists "metrics_refresh_runs: operators read"
  on public.metrics_refresh_runs;
create policy "metrics_refresh_runs: operators read"
  on public.metrics_refresh_runs for select
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.user_id = auth.uid()
    )
  );
