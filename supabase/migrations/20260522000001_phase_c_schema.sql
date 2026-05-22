-- Phase C: workspace, products, accounts, settings, activity.
-- RLS-safe, workspace-scoped, no service-role dependency.

set search_path = public;

create extension if not exists pgcrypto;

-- WORKSPACES -----------------------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- WORKSPACE MEMBERS ----------------------------------------------------------

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

-- PRODUCTS -------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  domain text,
  summary text,
  category text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_workspace_idx
  on public.products (workspace_id);

-- GROWTH ACCOUNTS ------------------------------------------------------------

create table if not exists public.growth_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  platform text not null,
  handle text,
  display_name text,
  role text,
  status text not null default 'planned',
  connection_status text not null default 'not_connected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists growth_accounts_workspace_idx
  on public.growth_accounts (workspace_id);

create index if not exists growth_accounts_product_idx
  on public.growth_accounts (product_id);

-- WORKSPACE SETTINGS ---------------------------------------------------------

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  region text,
  timezone text,
  language text,
  demo_mode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ACTIVITY EVENTS ------------------------------------------------------------

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_events_workspace_created_idx
  on public.activity_events (workspace_id, created_at desc);

-- UPDATED_AT TRIGGER ---------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists workspaces_touch on public.workspaces;
create trigger workspaces_touch
  before update on public.workspaces
  for each row execute function public.touch_updated_at();

drop trigger if exists products_touch on public.products;
create trigger products_touch
  before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists growth_accounts_touch on public.growth_accounts;
create trigger growth_accounts_touch
  before update on public.growth_accounts
  for each row execute function public.touch_updated_at();

drop trigger if exists workspace_settings_touch on public.workspace_settings;
create trigger workspace_settings_touch
  before update on public.workspace_settings
  for each row execute function public.touch_updated_at();
