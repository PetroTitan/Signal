-- Phase E2 — Execution Engine.
--
-- Adds the four tables that drive durable execution of an approved
-- weekly operating contract:
--
--   execution_queues    — one envelope per active week
--   execution_items     — the concrete units the runner evaluates
--   execution_logs      — append-only audit trail (queue + item events)
--   execution_attempts  — append-first per-attempt history
--
-- Nothing in this migration unlocks external publishing. Execution is
-- dry-run only until a separate phase wires real platform adapters.
--
-- Every table is workspace-scoped and references public.workspaces(id)
-- on delete cascade. RLS lives in 20260522050002_phase_e2_execution_rls.sql.

set search_path = public;

-- EXECUTION QUEUES ------------------------------------------------------------

create table if not exists public.execution_queues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,

  title text not null,
  status text not null default 'draft' check (status in (
    'draft', 'ready', 'running', 'paused', 'completed', 'cancelled', 'failed'
  )),
  week_start date not null,
  week_end date not null,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint execution_queues_week_range_check check (week_end >= week_start)
);

create index if not exists execution_queues_workspace_status_idx
  on public.execution_queues (workspace_id, status);

create index if not exists execution_queues_workspace_week_idx
  on public.execution_queues (workspace_id, week_start desc);

create index if not exists execution_queues_contract_idx
  on public.execution_queues (contract_id);

-- Only one non-terminal queue per contract at a time. Lets the UI
-- assume there is at most one "current" queue without scanning.
create unique index if not exists execution_queues_one_live_per_contract
  on public.execution_queues (contract_id)
  where status in ('draft', 'ready', 'running', 'paused');

drop trigger if exists execution_queues_touch on public.execution_queues;
create trigger execution_queues_touch
  before update on public.execution_queues
  for each row execute function public.touch_updated_at();

-- EXECUTION ITEMS -------------------------------------------------------------

create table if not exists public.execution_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  queue_id uuid not null references public.execution_queues(id) on delete cascade,
  contract_id uuid not null references public.weekly_approval_contracts(id) on delete restrict,

  -- Optional pointer back to the source row that produced this
  -- item (typically a weekly_plan_items row, but we keep it loose).
  source_entity_type text,
  source_entity_id uuid,

  product_id uuid references public.products(id) on delete set null,
  account_id uuid references public.growth_accounts(id) on delete set null,
  platform text,

  action_type text not null,
  title text,
  body text,
  link_url text,

  scheduled_at timestamptz,

  status text not null default 'pending_authorization' check (status in (
    'pending_authorization',
    'authorized',
    'scheduled',
    'ready',
    'running',
    'completed',
    'blocked',
    'backlogged',
    'skipped',
    'paused',
    'failed',
    'cancelled'
  )),

  risk_score integer check (risk_score is null or risk_score between 0 and 100),
  risk_level text check (risk_level is null or risk_level in (
    'low', 'medium', 'high', 'blocked'
  )),

  authorization_id uuid references public.execution_authorizations(id) on delete set null,

  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists execution_items_queue_idx
  on public.execution_items (queue_id);

create index if not exists execution_items_workspace_status_idx
  on public.execution_items (workspace_id, status);

create index if not exists execution_items_workspace_scheduled_idx
  on public.execution_items (workspace_id, scheduled_at)
  where scheduled_at is not null;

drop trigger if exists execution_items_touch on public.execution_items;
create trigger execution_items_touch
  before update on public.execution_items
  for each row execute function public.touch_updated_at();

-- EXECUTION LOGS --------------------------------------------------------------
--
-- Append-only audit trail. RLS restricts inserts to workspace members
-- and forbids updates/deletes.

create table if not exists public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  queue_id uuid references public.execution_queues(id) on delete cascade,
  execution_item_id uuid references public.execution_items(id) on delete cascade,

  event_type text not null,
  severity text not null default 'info' check (severity in (
    'debug', 'info', 'warning', 'error'
  )),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists execution_logs_workspace_created_idx
  on public.execution_logs (workspace_id, created_at desc);

create index if not exists execution_logs_queue_created_idx
  on public.execution_logs (queue_id, created_at desc)
  where queue_id is not null;

create index if not exists execution_logs_item_created_idx
  on public.execution_logs (execution_item_id, created_at desc)
  where execution_item_id is not null;

-- EXECUTION ATTEMPTS ----------------------------------------------------------
--
-- Append-first; the runner updates `finished_at`, `status`, and
-- `error_summary` after the attempt resolves. Update policy in RLS
-- allows that path. Deletes are forbidden.

create table if not exists public.execution_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  execution_item_id uuid not null references public.execution_items(id) on delete cascade,

  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in (
    'started', 'succeeded', 'failed', 'skipped', 'blocked'
  )),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  unique (execution_item_id, attempt_number)
);

create index if not exists execution_attempts_item_idx
  on public.execution_attempts (execution_item_id, attempt_number);

create index if not exists execution_attempts_workspace_status_idx
  on public.execution_attempts (workspace_id, status);
