-- Safe primary-workspace resolver.
--
-- When a user has membership in multiple workspaces, the previous
-- behavior was "earliest created wins" — which silently routes new
-- signups to whichever workspace happened to be created first, even
-- if a later workspace is the canonical one with real data.
--
-- This migration adds an explicit per-user `is_primary` flag on
-- workspace_members. The resolver prefers `is_primary=true`, then
-- falls back to the previous created_at ordering.

set search_path = public;

alter table public.workspace_members
  add column if not exists is_primary boolean not null default false;

-- Enforce at most one primary workspace per user. NULL-able would
-- work too, but boolean + partial unique index is the standard
-- pattern and stays correctly indexed for the resolver query.
drop index if exists workspace_members_user_primary_unique;
create unique index workspace_members_user_primary_unique
  on public.workspace_members (user_id)
  where is_primary;
