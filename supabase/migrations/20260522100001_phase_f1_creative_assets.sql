-- Phase F1 — creative assets for weekly plan items.
--
-- Posts cannot enter the publishing queue without a creative attached
-- (image / video / animation) and an explicit license + alt-text. This
-- table is the link between a weekly_plan_item and its creative plan;
-- every publishable post has ≥1 row here.

set search_path = public;

create table if not exists public.weekly_plan_item_creatives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  weekly_plan_item_id uuid not null references public.weekly_plan_items(id) on delete cascade,

  -- What kind of creative this is.
  creative_type text not null
    check (creative_type in ('image', 'video', 'animation')),

  -- Where the asset comes from. Drives the license/attribution rules.
  source_type text not null
    check (source_type in (
      'generated',        -- AI-generated; prompt required
      'uploaded',         -- operator-uploaded file
      'wikimedia',        -- Wikimedia / public-domain / CC
      'official_source',  -- product screenshot, own marketing site, etc.
      'manual_url',       -- arbitrary URL with explicit license notes
      'planned'           -- placeholder — operator hasn't chosen yet
    )),

  -- For 'wikimedia' / 'manual_url': the original source.
  source_url text,
  -- The actual file/URL that will be uploaded to the platform at post time.
  asset_url text,
  -- For 'generated': the text prompt used (or to be used).
  prompt text,

  -- Accessibility — required before publish.
  alt_text text,
  -- License string ("CC-BY-4.0", "Public Domain", "© Acme Corp", etc.).
  license text,
  -- Attribution string ("by Jane Doe via Wikimedia Commons").
  attribution text,
  -- Free-text notes from the risk reviewer.
  risk_notes text,

  status text not null default 'planned'
    check (status in ('planned', 'pending_review', 'approved', 'rejected')),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists weekly_plan_item_creatives_item_idx
  on public.weekly_plan_item_creatives (weekly_plan_item_id);

create index if not exists weekly_plan_item_creatives_workspace_status_idx
  on public.weekly_plan_item_creatives (workspace_id, status);

create trigger weekly_plan_item_creatives_touch_updated_at
  before update on public.weekly_plan_item_creatives
  for each row execute function public.touch_updated_at();

-- RLS — same workspace-member pattern as Phase D.

alter table public.weekly_plan_item_creatives enable row level security;

drop policy if exists "plan_item_creatives: members can read"
  on public.weekly_plan_item_creatives;
create policy "plan_item_creatives: members can read"
  on public.weekly_plan_item_creatives for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "plan_item_creatives: members can insert"
  on public.weekly_plan_item_creatives;
create policy "plan_item_creatives: members can insert"
  on public.weekly_plan_item_creatives for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "plan_item_creatives: members can update"
  on public.weekly_plan_item_creatives;
create policy "plan_item_creatives: members can update"
  on public.weekly_plan_item_creatives for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "plan_item_creatives: members can delete"
  on public.weekly_plan_item_creatives;
create policy "plan_item_creatives: members can delete"
  on public.weekly_plan_item_creatives for delete
  using (public.is_workspace_member(workspace_id));
