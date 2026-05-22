-- Phase F0 — Signal MCP server.
--
-- Two tables to back the outward-facing MCP HTTP bridge:
--
--   mcp_operator_tokens  — long-lived bearer tokens an operator's
--                          Claude Code / Codex client uses to
--                          authenticate against /api/mcp.
--   mcp_tool_calls       — append-only audit trail; every tool
--                          invocation persists one row.
--
-- Token discipline: only the SHA-256 hash is stored. The plaintext is
-- shown to the operator exactly once and never leaves the create
-- response. No service-role anywhere.

set search_path = public;

-- OPERATOR TOKENS -------------------------------------------------------------

create table if not exists public.mcp_operator_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,

  name text not null,
  -- SHA-256 of the plaintext token. Unique so a lookup by hash is
  -- O(1).
  token_hash text not null unique,
  -- First 8 chars of the plaintext token, captured at create time so
  -- the UI can show a fingerprint without ever rendering the secret.
  token_preview text not null,

  status text not null default 'active' check (status in (
    'active', 'revoked', 'expired'
  )),

  scopes text[] not null default '{}',

  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_operator_tokens_workspace_idx
  on public.mcp_operator_tokens (workspace_id, status);

create index if not exists mcp_operator_tokens_workspace_created_idx
  on public.mcp_operator_tokens (workspace_id, created_at desc);

-- RLS — workspace members read; only owners/admins create or revoke.

create or replace function public.mcp_token_can_manage(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  );
$$;

grant execute on function public.mcp_token_can_manage(uuid) to authenticated;

alter table public.mcp_operator_tokens enable row level security;

drop policy if exists "mcp_operator_tokens: members can read"
  on public.mcp_operator_tokens;
create policy "mcp_operator_tokens: members can read"
  on public.mcp_operator_tokens for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "mcp_operator_tokens: managers can insert"
  on public.mcp_operator_tokens;
create policy "mcp_operator_tokens: managers can insert"
  on public.mcp_operator_tokens for insert
  with check (
    public.mcp_token_can_manage(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists "mcp_operator_tokens: managers can update"
  on public.mcp_operator_tokens;
create policy "mcp_operator_tokens: managers can update"
  on public.mcp_operator_tokens for update
  using (public.mcp_token_can_manage(workspace_id))
  with check (public.mcp_token_can_manage(workspace_id));

-- No DELETE. Revoke via status='revoked'; the audit trail stays.

-- TOOL CALLS ------------------------------------------------------------------

create table if not exists public.mcp_tool_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  operator_token_id uuid references public.mcp_operator_tokens(id) on delete set null,

  tool_name text not null,
  risk_level text not null check (risk_level in (
    'safe_read', 'local_write', 'remote_write', 'production_impacting', 'blocked'
  )),
  approval_mode text not null check (approval_mode in (
    'no_approval_needed',
    'approval_required',
    'explicit_text_confirmation_required',
    'blocked'
  )),

  status text not null check (status in (
    'allowed', 'completed', 'failed', 'blocked', 'unauthorized'
  )),

  input_summary text,
  output_summary text,
  error_summary text,

  created_at timestamptz not null default now()
);

create index if not exists mcp_tool_calls_workspace_created_idx
  on public.mcp_tool_calls (workspace_id, created_at desc);

create index if not exists mcp_tool_calls_workspace_tool_idx
  on public.mcp_tool_calls (workspace_id, tool_name, created_at desc);

create index if not exists mcp_tool_calls_token_idx
  on public.mcp_tool_calls (operator_token_id, created_at desc)
  where operator_token_id is not null;

alter table public.mcp_tool_calls enable row level security;

drop policy if exists "mcp_tool_calls: members can read" on public.mcp_tool_calls;
create policy "mcp_tool_calls: members can read"
  on public.mcp_tool_calls for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "mcp_tool_calls: members can insert" on public.mcp_tool_calls;
create policy "mcp_tool_calls: members can insert"
  on public.mcp_tool_calls for insert
  with check (public.is_workspace_member(workspace_id));

-- No UPDATE / DELETE policy. The audit table is append-only.
