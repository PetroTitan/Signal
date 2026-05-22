-- Phase C RLS policies.
-- Principle: every read and write must prove workspace membership.
-- No service-role dependency. No public exposure.

set search_path = public;

-- ENABLE RLS -----------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.products enable row level security;
alter table public.growth_accounts enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.activity_events enable row level security;

-- HELPER: is user a member of a workspace? -----------------------------------

create or replace function public.is_workspace_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target
      and wm.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_owner(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target
      and wm.user_id = auth.uid()
      and wm.role = 'owner'
  );
$$;

-- WORKSPACES -----------------------------------------------------------------

drop policy if exists "workspaces: members can read" on public.workspaces;
create policy "workspaces: members can read"
  on public.workspaces for select
  using (public.is_workspace_member(id));

-- The authenticated user creating a workspace must set themselves as
-- created_by; the workspace_members.insert policy enforces that they
-- immediately add themselves as a member.
drop policy if exists "workspaces: anyone can create" on public.workspaces;
create policy "workspaces: anyone can create"
  on public.workspaces for insert
  with check (auth.uid() = created_by);

drop policy if exists "workspaces: owners can update" on public.workspaces;
create policy "workspaces: owners can update"
  on public.workspaces for update
  using (public.is_workspace_owner(id));

drop policy if exists "workspaces: owners can delete" on public.workspaces;
create policy "workspaces: owners can delete"
  on public.workspaces for delete
  using (public.is_workspace_owner(id));

-- WORKSPACE MEMBERS ----------------------------------------------------------

drop policy if exists "members: read own rows or fellow members" on public.workspace_members;
create policy "members: read own rows or fellow members"
  on public.workspace_members for select
  using (
    user_id = auth.uid()
    or public.is_workspace_member(workspace_id)
  );

-- A user may add themselves to a workspace they just created (the
-- workspace insert policy already enforced created_by = auth.uid()).
-- Owners can add other members.
drop policy if exists "members: self-insert or owner-insert" on public.workspace_members;
create policy "members: self-insert or owner-insert"
  on public.workspace_members for insert
  with check (
    (user_id = auth.uid())
    or public.is_workspace_owner(workspace_id)
  );

drop policy if exists "members: owners can update" on public.workspace_members;
create policy "members: owners can update"
  on public.workspace_members for update
  using (public.is_workspace_owner(workspace_id));

drop policy if exists "members: owners can delete" on public.workspace_members;
create policy "members: owners can delete"
  on public.workspace_members for delete
  using (public.is_workspace_owner(workspace_id));

-- PRODUCTS -------------------------------------------------------------------

drop policy if exists "products: members can read" on public.products;
create policy "products: members can read"
  on public.products for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "products: members can insert" on public.products;
create policy "products: members can insert"
  on public.products for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "products: members can update" on public.products;
create policy "products: members can update"
  on public.products for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "products: members can delete" on public.products;
create policy "products: members can delete"
  on public.products for delete
  using (public.is_workspace_member(workspace_id));

-- GROWTH ACCOUNTS ------------------------------------------------------------

drop policy if exists "accounts: members can read" on public.growth_accounts;
create policy "accounts: members can read"
  on public.growth_accounts for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "accounts: members can insert" on public.growth_accounts;
create policy "accounts: members can insert"
  on public.growth_accounts for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "accounts: members can update" on public.growth_accounts;
create policy "accounts: members can update"
  on public.growth_accounts for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "accounts: members can delete" on public.growth_accounts;
create policy "accounts: members can delete"
  on public.growth_accounts for delete
  using (public.is_workspace_member(workspace_id));

-- WORKSPACE SETTINGS ---------------------------------------------------------

drop policy if exists "settings: members can read" on public.workspace_settings;
create policy "settings: members can read"
  on public.workspace_settings for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "settings: members can insert" on public.workspace_settings;
create policy "settings: members can insert"
  on public.workspace_settings for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "settings: members can update" on public.workspace_settings;
create policy "settings: members can update"
  on public.workspace_settings for update
  using (public.is_workspace_member(workspace_id));

-- ACTIVITY EVENTS ------------------------------------------------------------

drop policy if exists "activity: members can read" on public.activity_events;
create policy "activity: members can read"
  on public.activity_events for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "activity: members can insert" on public.activity_events;
create policy "activity: members can insert"
  on public.activity_events for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

-- Activity events are append-only by design. No update / delete policies.
