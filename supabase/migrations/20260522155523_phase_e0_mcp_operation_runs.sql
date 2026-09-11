-- Phase E0 — mcp_operation_runs + activity_events linkage.
--
-- This table is the audit trail for every MCP-driven operation Signal
-- runs (suggest, import, confirm, apply migration, etc.). Workspace
-- scoped, RLS-protected. No service-role dependency.

set search_path = public;

create table if not exists public.mcp_operation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,

  operation_type text not null check (operation_type in (
    'product_profile_suggest',
    'product_profile_create_pending',
    'product_profile_confirm',
    'account_profile_suggest',
    'account_profile_create_pending',
    'account_profile_confirm',
    'screenshot_account_import',
    'screenshot_product_import',
    'weekly_plan_suggest',
    'db_integrity_check',
    'rls_check',
    'smoke_test_run',
    'migration_plan_prepare',
    'migration_apply_request',
    'pr_readiness_check',
    'deployment_readiness_check',
    'production_smoke_test'
  )),

  risk_level text not null check (risk_level in (
    'safe_read', 'local_write', 'remote_write', 'production_impacting', 'blocked'
  )),

  approval_mode text not null check (approval_mode in (
    'no_approval_needed',
    'approval_required',
    'explicit_text_confirmation_required',
    'blocked'
  )),

  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'running',
    'completed', 'failed', 'rejected', 'blocked'
  )),

  input_summary text,
  output_summary text,
  error_summary text,
  requires_user_approval boolean not null default true,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mcp_operation_runs_workspace_created_idx
  on public.mcp_operation_runs (workspace_id, created_at desc);

create index if not exists mcp_operation_runs_workspace_status_idx
  on public.mcp_operation_runs (workspace_id, status);

drop trigger if exists mcp_operation_runs_touch on public.mcp_operation_runs;
create trigger mcp_operation_runs_touch
  before update on public.mcp_operation_runs
  for each row execute function public.touch_updated_at();

-- RLS ------------------------------------------------------------------------

alter table public.mcp_operation_runs enable row level security;

drop policy if exists "mcp_runs: members can read" on public.mcp_operation_runs;
create policy "mcp_runs: members can read"
  on public.mcp_operation_runs for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "mcp_runs: members can insert" on public.mcp_operation_runs;
create policy "mcp_runs: members can insert"
  on public.mcp_operation_runs for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

drop policy if exists "mcp_runs: members can update" on public.mcp_operation_runs;
create policy "mcp_runs: members can update"
  on public.mcp_operation_runs for update
  using (public.is_workspace_member(workspace_id));

-- No DELETE policy. Runs are append-friendly history; archiving is via
-- status='rejected' or status='blocked'.

-- ACTIVITY EVENTS ↔ OPERATION RUNS ------------------------------------------

alter table public.activity_events
  add column if not exists operation_id uuid references public.mcp_operation_runs(id) on delete set null;

alter table public.activity_events
  add column if not exists review_status text
    check (review_status in ('pending_review', 'confirmed', 'rejected', 'needs_edit'));

create index if not exists activity_events_operation_idx
  on public.activity_events (operation_id)
  where operation_id is not null;
