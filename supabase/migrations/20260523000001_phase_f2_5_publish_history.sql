-- Phase F2.5 — publish history (rate limits + duplicate prevention).
--
-- One row per **live** publish attempt that left Vercel for Reddit.
-- The scheduler-only-skip path (dry-run, ready_for_publish) does NOT
-- write here. Only the controlled-publish action writes here.
--
-- Used by:
--   - rate-limit policy   (60-min / 24-h windows)
--   - duplicate-content policy (30-day fingerprint window)
--   - audit / activity surfaces

set search_path = public;

create table if not exists public.publish_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  execution_item_id uuid not null references public.execution_items(id) on delete cascade,
  account_id uuid references public.growth_accounts(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,

  platform text not null,           -- 'reddit', etc.
  subreddit text,                   -- platform-specific target (sr name without /r/)
  fingerprint text not null,        -- sha256 of canonical(platform|subreddit|title|body|link_url)
  title_hash text,                  -- sha256 of normalized title
  body_hash text,                   -- sha256 of normalized body
  link_url text,

  provider_post_id text,            -- Reddit "name" (e.g. t3_abc123)
  provider_permalink text,          -- Full URL to the published post
  outcome text not null check (outcome in ('published', 'failed', 'blocked')),
  reason_code text,                 -- on failed/blocked
  http_status integer,              -- Reddit HTTP status if applicable

  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists publish_history_workspace_finished_idx
  on public.publish_history (workspace_id, finished_at desc);

create index if not exists publish_history_workspace_fingerprint_idx
  on public.publish_history (workspace_id, fingerprint, finished_at desc);

create index if not exists publish_history_execution_item_idx
  on public.publish_history (execution_item_id);

-- RLS — same workspace-member pattern as the rest of Phase E2.

alter table public.publish_history enable row level security;

drop policy if exists "publish_history: members can read"
  on public.publish_history;
create policy "publish_history: members can read"
  on public.publish_history for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "publish_history: members can insert"
  on public.publish_history;
create policy "publish_history: members can insert"
  on public.publish_history for insert
  with check (public.is_workspace_member(workspace_id));

-- No update / delete — publish history is append-only.
