-- Phase E2.8 — Operator bridge runtime.
--
-- Three tables that model the operator-side bridge:
--
--   operator_bridge_requests  — one row per task Signal asks the
--                               operator to run in Claude / Codex / Opus
--   operator_bridge_results   — append-first per-submission history
--   operator_bridge_nonces    — one-shot replay-protection tokens
--
-- All workspace-scoped, RLS-protected. No service-role anywhere.

set search_path = public;

-- REQUESTS --------------------------------------------------------------------

create table if not exists public.operator_bridge_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operation_run_id uuid references public.mcp_operation_runs(id) on delete set null,
  requested_by uuid references auth.users(id) on delete set null,

  assigned_to text,
  assistant_type text not null check (assistant_type in (
    'claude_code', 'codex', 'claude_opus', 'supabase_mcp', 'github_mcp', 'vercel_manual'
  )),
  request_type text not null check (request_type in (
    'repo_check',
    'db_check',
    'rls_check',
    'migration_review',
    'pr_readiness_review',
    'import_mapping',
    'smoke_test',
    'deployment_review',
    'architecture_audit'
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
    'draft',
    'pending_operator',
    'copied',
    'running',
    'result_submitted',
    'verified',
    'failed_verification',
    'expired',
    'cancelled',
    'rejected',
    'completed'
  )),

  title text not null,
  task_prompt text not null,
  expected_result_schema jsonb not null default '{}'::jsonb,
  allowed_capabilities text[] not null default '{}',
  blocked_capabilities text[] not null default '{}',

  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operator_bridge_requests_workspace_status_idx
  on public.operator_bridge_requests (workspace_id, status);

create index if not exists operator_bridge_requests_workspace_created_idx
  on public.operator_bridge_requests (workspace_id, created_at desc);

drop trigger if exists operator_bridge_requests_touch on public.operator_bridge_requests;
create trigger operator_bridge_requests_touch
  before update on public.operator_bridge_requests
  for each row execute function public.touch_updated_at();

-- RESULTS ---------------------------------------------------------------------

create table if not exists public.operator_bridge_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.operator_bridge_requests(id) on delete cascade,
  submitted_by uuid references auth.users(id) on delete set null,

  assistant_type text not null check (assistant_type in (
    'claude_code', 'codex', 'claude_opus', 'supabase_mcp', 'github_mcp', 'vercel_manual'
  )),
  status text not null default 'submitted' check (status in (
    'submitted', 'verified', 'rejected', 'failed'
  )),

  result_summary text not null,
  result_payload jsonb not null default '{}'::jsonb,
  verification_status text not null default 'pending' check (verification_status in (
    'pending', 'verified', 'rejected', 'failed'
  )),
  verification_errors text[] not null default '{}',

  signature text,
  signed_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists operator_bridge_results_workspace_idx
  on public.operator_bridge_results (workspace_id, created_at desc);

create index if not exists operator_bridge_results_request_idx
  on public.operator_bridge_results (request_id, created_at desc);

-- NONCES ----------------------------------------------------------------------

create table if not exists public.operator_bridge_nonces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.operator_bridge_requests(id) on delete cascade,

  nonce text not null unique,
  status text not null default 'active' check (status in (
    'active', 'used', 'expired', 'revoked'
  )),

  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists operator_bridge_nonces_workspace_idx
  on public.operator_bridge_nonces (workspace_id);

create index if not exists operator_bridge_nonces_request_idx
  on public.operator_bridge_nonces (request_id);

-- RLS ------------------------------------------------------------------------

alter table public.operator_bridge_requests enable row level security;

drop policy if exists "operator_bridge_requests: members can read"
  on public.operator_bridge_requests;
create policy "operator_bridge_requests: members can read"
  on public.operator_bridge_requests for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "operator_bridge_requests: members can insert"
  on public.operator_bridge_requests;
create policy "operator_bridge_requests: members can insert"
  on public.operator_bridge_requests for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (requested_by is null or requested_by = auth.uid())
  );

drop policy if exists "operator_bridge_requests: members can update"
  on public.operator_bridge_requests;
create policy "operator_bridge_requests: members can update"
  on public.operator_bridge_requests for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy. Requests are history.

alter table public.operator_bridge_results enable row level security;

drop policy if exists "operator_bridge_results: members can read"
  on public.operator_bridge_results;
create policy "operator_bridge_results: members can read"
  on public.operator_bridge_results for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "operator_bridge_results: members can insert"
  on public.operator_bridge_results;
create policy "operator_bridge_results: members can insert"
  on public.operator_bridge_results for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "operator_bridge_results: members can update"
  on public.operator_bridge_results;
create policy "operator_bridge_results: members can update"
  on public.operator_bridge_results for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE. Results are append-only history.

alter table public.operator_bridge_nonces enable row level security;

drop policy if exists "operator_bridge_nonces: members can read"
  on public.operator_bridge_nonces;
create policy "operator_bridge_nonces: members can read"
  on public.operator_bridge_nonces for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "operator_bridge_nonces: members can insert"
  on public.operator_bridge_nonces;
create policy "operator_bridge_nonces: members can insert"
  on public.operator_bridge_nonces for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "operator_bridge_nonces: members can update"
  on public.operator_bridge_nonces;
create policy "operator_bridge_nonces: members can update"
  on public.operator_bridge_nonces for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE. Nonces are consumed via status='used' / 'expired' / 'revoked',
-- never deleted, so replay attempts always find the audit trail.
