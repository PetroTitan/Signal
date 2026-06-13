-- Phase C3.6 — verified post-metrics cache.
--
-- Additive, RLS-safe. Caches ONLY provider-verified metric values
-- (likes/reposts/replies/score/comments) fetched from official platform
-- APIs. Never stores estimated/derived analytics. References
-- publish_history.id by FK for read only — publish_history itself is
-- NOT altered. external_post_id (Adjustment 2) stores the provider post
-- id needed to refresh metrics per platform; status includes 'pending'
-- (Adjustment 2) for "queued for first fetch".

set search_path = public;

create table if not exists public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  publish_history_id uuid not null references public.publish_history(id) on delete cascade,
  platform text not null,
  source text not null,          -- e.g. 'bluesky_getposts' | 'reddit_info' | 'x_api_v2'
  external_post_id text,         -- provider post id / at-uri used to refresh
  status text not null default 'pending'
    check (status in ('connected', 'unavailable', 'unsupported', 'pending')),
  metrics jsonb not null default '{}'::jsonb,   -- provider-verified counts ONLY
  fetched_at timestamptz,
  next_refresh_at timestamptz,
  error text,                    -- last refresh failure (logged, never faked)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (publish_history_id, source)
);

create index if not exists post_metrics_ws_idx
  on public.post_metrics (workspace_id, updated_at desc);
-- Drives the scheduled refresh sweep: only 'connected' rows with a due
-- next_refresh_at are candidates.
create index if not exists post_metrics_refresh_idx
  on public.post_metrics (next_refresh_at)
  where status = 'connected';

alter table public.post_metrics enable row level security;

drop policy if exists "post_metrics: members read" on public.post_metrics;
create policy "post_metrics: members read"
  on public.post_metrics for select
  using (public.is_workspace_member(workspace_id));

-- Members may trigger a refresh that writes cached metrics for their
-- own workspace. The scheduled refresh job uses the service-role client.
drop policy if exists "post_metrics: members insert" on public.post_metrics;
create policy "post_metrics: members insert"
  on public.post_metrics for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "post_metrics: members update" on public.post_metrics;
create policy "post_metrics: members update"
  on public.post_metrics for update
  using (public.is_workspace_member(workspace_id));
