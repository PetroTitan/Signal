-- Phase E2.7 — MCP connector probes.
--
-- One row per probe attempt against an MCP-connected (or
-- MCP-emulated) data plane. Workspace-scoped. Append-friendly history;
-- the runner updates the same row across `pending → running →
-- completed | failed | expired | rejected`.
--
-- The table is generic across connector kinds; today we only probe
-- the Supabase data plane (`connector_type = 'supabase_mcp'`).

set search_path = public;

create table if not exists public.mcp_connector_probes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connector_type text not null check (connector_type in (
    'supabase_mcp', 'github_mcp', 'vercel_manual'
  )),

  -- Honesty axis. Phase E2.7 only ships `internal_db_probe`; the other
  -- two modes are documented but not yet wired.
  mode text not null default 'internal_db_probe' check (mode in (
    'direct_mcp', 'operator_bridge', 'internal_db_probe'
  )),

  status text not null default 'pending' check (status in (
    'pending', 'running', 'completed', 'failed', 'expired', 'rejected'
  )),

  requested_by uuid references auth.users(id) on delete set null,
  completed_by uuid references auth.users(id) on delete set null,

  capability_results jsonb not null default '{}'::jsonb,
  health_status text check (health_status is null or health_status in (
    'healthy', 'degraded', 'failed', 'unknown'
  )),
  error_summary text,
  evidence jsonb not null default '{}'::jsonb,

  expires_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists mcp_connector_probes_workspace_idx
  on public.mcp_connector_probes (workspace_id, created_at desc);

create index if not exists mcp_connector_probes_workspace_connector_idx
  on public.mcp_connector_probes (workspace_id, connector_type, created_at desc);

-- RLS ------------------------------------------------------------------------

alter table public.mcp_connector_probes enable row level security;

drop policy if exists "mcp_connector_probes: members can read"
  on public.mcp_connector_probes;
create policy "mcp_connector_probes: members can read"
  on public.mcp_connector_probes for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "mcp_connector_probes: members can insert"
  on public.mcp_connector_probes;
create policy "mcp_connector_probes: members can insert"
  on public.mcp_connector_probes for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (requested_by is null or requested_by = auth.uid())
  );

drop policy if exists "mcp_connector_probes: members can update"
  on public.mcp_connector_probes;
create policy "mcp_connector_probes: members can update"
  on public.mcp_connector_probes for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy. Probes are history.
