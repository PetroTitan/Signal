-- Phase D: weekly plans, plan items, approvals, backlog, scheduling,
-- risk events, draft variants. All workspace-scoped, RLS-safe, no
-- service-role dependency.

set search_path = public;

-- WEEKLY PLANS ---------------------------------------------------------------

create table if not exists public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  week_start date not null,
  status text not null default 'draft'
    check (status in ('draft', 'review', 'approved', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists weekly_plans_workspace_week_idx
  on public.weekly_plans (workspace_id, week_start desc);

create unique index if not exists weekly_plans_workspace_week_unique
  on public.weekly_plans (workspace_id, week_start);

-- WEEKLY PLAN ITEMS ----------------------------------------------------------

create table if not exists public.weekly_plan_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  weekly_plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  account_id uuid references public.growth_accounts(id) on delete set null,
  platform text,
  content_type text,
  title text,
  body text,
  cta text,
  link_url text,
  status text not null default 'draft'
    check (status in (
      'draft', 'pending_approval', 'approved', 'rejected',
      'scheduled', 'published', 'skipped', 'backlog', 'paused'
    )),
  risk_level text check (risk_level in ('low', 'medium', 'high', 'blocked')),
  risk_score integer,
  scheduled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists weekly_plan_items_plan_idx
  on public.weekly_plan_items (weekly_plan_id);

create index if not exists weekly_plan_items_workspace_status_idx
  on public.weekly_plan_items (workspace_id, status);

create index if not exists weekly_plan_items_workspace_scheduled_idx
  on public.weekly_plan_items (workspace_id, scheduled_at);

-- APPROVAL EVENTS ------------------------------------------------------------

create table if not exists public.approval_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  weekly_plan_item_id uuid references public.weekly_plan_items(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null
    check (action in (
      'approve', 'reject', 'send_to_backlog', 'restore_from_backlog',
      'rewrite_softer', 'convert_to_comment', 'remove_link',
      'schedule', 'pause', 'unschedule', 'delay'
    )),
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists approval_events_workspace_created_idx
  on public.approval_events (workspace_id, created_at desc);

create index if not exists approval_events_item_idx
  on public.approval_events (weekly_plan_item_id);

-- BACKLOG ITEMS --------------------------------------------------------------

create table if not exists public.backlog_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_item_id uuid references public.weekly_plan_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  account_id uuid references public.growth_accounts(id) on delete set null,
  platform text,
  title text,
  body text,
  reason text,
  status text not null default 'backlog'
    check (status in ('backlog', 'restored', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backlog_items_workspace_status_idx
  on public.backlog_items (workspace_id, status);

-- SCHEDULED ITEMS ------------------------------------------------------------

create table if not exists public.scheduled_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  weekly_plan_item_id uuid references public.weekly_plan_items(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  account_id uuid references public.growth_accounts(id) on delete set null,
  platform text,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'paused', 'published', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scheduled_items_workspace_when_idx
  on public.scheduled_items (workspace_id, scheduled_at);

create index if not exists scheduled_items_item_idx
  on public.scheduled_items (weekly_plan_item_id);

-- RISK EVENTS ----------------------------------------------------------------

create table if not exists public.risk_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  risk_level text not null
    check (risk_level in ('low', 'medium', 'high', 'blocked')),
  risk_score integer,
  reason text not null,
  recommendation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists risk_events_workspace_created_idx
  on public.risk_events (workspace_id, created_at desc);

create index if not exists risk_events_entity_idx
  on public.risk_events (entity_type, entity_id);

-- DRAFT VARIANTS -------------------------------------------------------------

create table if not exists public.draft_variants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  weekly_plan_item_id uuid references public.weekly_plan_items(id) on delete cascade,
  platform text,
  variant_type text,
  title text,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft', 'selected', 'discarded')),
  risk_level text check (risk_level in ('low', 'medium', 'high', 'blocked')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists draft_variants_item_idx
  on public.draft_variants (weekly_plan_item_id);

create index if not exists draft_variants_workspace_idx
  on public.draft_variants (workspace_id);

-- UPDATED_AT TRIGGERS --------------------------------------------------------

drop trigger if exists weekly_plans_touch on public.weekly_plans;
create trigger weekly_plans_touch
  before update on public.weekly_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists weekly_plan_items_touch on public.weekly_plan_items;
create trigger weekly_plan_items_touch
  before update on public.weekly_plan_items
  for each row execute function public.touch_updated_at();

drop trigger if exists backlog_items_touch on public.backlog_items;
create trigger backlog_items_touch
  before update on public.backlog_items
  for each row execute function public.touch_updated_at();

drop trigger if exists scheduled_items_touch on public.scheduled_items;
create trigger scheduled_items_touch
  before update on public.scheduled_items
  for each row execute function public.touch_updated_at();

drop trigger if exists draft_variants_touch on public.draft_variants;
create trigger draft_variants_touch
  before update on public.draft_variants
  for each row execute function public.touch_updated_at();
