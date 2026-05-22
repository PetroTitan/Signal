-- Phase E3 — Platform OAuth connections.
--
-- One row per (workspace, growth_account, platform) OAuth connection.
-- The table stores the *identity* of the connection (which account on
-- which platform, what scopes were granted, when it last verified) and
-- placeholders for encrypted tokens — but the token columns are only
-- written by server code, never exposed to the client, and never
-- logged.
--
-- This phase does NOT enable publishing. It models the connection and
-- prepares the routes so a future phase can wire real token storage
-- + adapter calls.

set search_path = public;

create table if not exists public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid references public.growth_accounts(id) on delete set null,

  platform text not null check (platform in ('reddit', 'x', 'linkedin')),

  provider_account_id text,
  handle text,
  display_name text,

  connection_status text not null default 'not_connected' check (connection_status in (
    'not_connected',
    'connected',
    'expired',
    'revoked',
    'error',
    'disabled',
    'reauthorization_required'
  )),

  scopes text[] not null default '{}',

  -- Token columns: never selected back into the client. Server-only.
  -- If encryption is not yet wired, the runtime must refuse to store a
  -- real token here — only placeholders.
  access_token_encrypted text,
  refresh_token_encrypted text,

  expires_at timestamptz,
  connected_at timestamptz,
  revoked_at timestamptz,
  last_checked_at timestamptz,

  health_status text not null default 'unknown' check (health_status in (
    'healthy', 'degraded', 'expired', 'revoked', 'unknown'
  )),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_connections_unique_per_account
  on public.platform_connections (workspace_id, account_id, platform)
  where account_id is not null;

create unique index if not exists platform_connections_unique_provider
  on public.platform_connections (workspace_id, platform, provider_account_id)
  where provider_account_id is not null;

create index if not exists platform_connections_workspace_status_idx
  on public.platform_connections (workspace_id, connection_status);

create index if not exists platform_connections_workspace_platform_idx
  on public.platform_connections (workspace_id, platform);

drop trigger if exists platform_connections_touch on public.platform_connections;
create trigger platform_connections_touch
  before update on public.platform_connections
  for each row execute function public.touch_updated_at();

-- RLS ------------------------------------------------------------------------
--
-- Workspace-scoped. NO column-level grants on token columns at the SQL
-- layer — application code is responsible for projecting away
-- access_token_encrypted / refresh_token_encrypted before returning to
-- the client. Postgrest does not allow per-column policies, so the
-- discipline lives in the repository layer.

alter table public.platform_connections enable row level security;

drop policy if exists "platform_connections: members can read"
  on public.platform_connections;
create policy "platform_connections: members can read"
  on public.platform_connections for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "platform_connections: members can insert"
  on public.platform_connections;
create policy "platform_connections: members can insert"
  on public.platform_connections for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "platform_connections: members can update"
  on public.platform_connections;
create policy "platform_connections: members can update"
  on public.platform_connections for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy. Revocation is via connection_status='revoked',
-- not row deletion.

-- OAUTH STATE TOKENS ----------------------------------------------------------
--
-- Short-lived state values used to verify OAuth callbacks. The state
-- table is workspace-scoped; rows are inserted at /start and consumed
-- (deleted) at /callback. A unique constraint on the state itself
-- prevents replay.

create table if not exists public.oauth_state_tokens (
  state text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('reddit', 'x', 'linkedin')),
  account_id uuid references public.growth_accounts(id) on delete set null,
  redirect_after text,
  code_verifier text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists oauth_state_tokens_workspace_idx
  on public.oauth_state_tokens (workspace_id);

create index if not exists oauth_state_tokens_expires_idx
  on public.oauth_state_tokens (expires_at);

alter table public.oauth_state_tokens enable row level security;

drop policy if exists "oauth_state_tokens: owner can read"
  on public.oauth_state_tokens;
create policy "oauth_state_tokens: owner can read"
  on public.oauth_state_tokens for select
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "oauth_state_tokens: owner can insert"
  on public.oauth_state_tokens;
create policy "oauth_state_tokens: owner can insert"
  on public.oauth_state_tokens for insert
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "oauth_state_tokens: owner can delete"
  on public.oauth_state_tokens;
create policy "oauth_state_tokens: owner can delete"
  on public.oauth_state_tokens for delete
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
