-- Phase D RLS policies.
-- Same workspace-scoped model as Phase C. Reuses is_workspace_member()
-- and is_workspace_owner() helpers.

set search_path = public;

alter table public.weekly_plans enable row level security;
alter table public.weekly_plan_items enable row level security;
alter table public.approval_events enable row level security;
alter table public.backlog_items enable row level security;
alter table public.scheduled_items enable row level security;
alter table public.risk_events enable row level security;
alter table public.draft_variants enable row level security;

-- WEEKLY PLANS ---------------------------------------------------------------

drop policy if exists "weekly_plans: members can read" on public.weekly_plans;
create policy "weekly_plans: members can read"
  on public.weekly_plans for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_plans: members can insert" on public.weekly_plans;
create policy "weekly_plans: members can insert"
  on public.weekly_plans for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists "weekly_plans: members can update" on public.weekly_plans;
create policy "weekly_plans: members can update"
  on public.weekly_plans for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_plans: owners can delete" on public.weekly_plans;
create policy "weekly_plans: owners can delete"
  on public.weekly_plans for delete
  using (public.is_workspace_owner(workspace_id));

-- WEEKLY PLAN ITEMS ----------------------------------------------------------

drop policy if exists "plan_items: members can read" on public.weekly_plan_items;
create policy "plan_items: members can read"
  on public.weekly_plan_items for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "plan_items: members can insert" on public.weekly_plan_items;
create policy "plan_items: members can insert"
  on public.weekly_plan_items for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "plan_items: members can update" on public.weekly_plan_items;
create policy "plan_items: members can update"
  on public.weekly_plan_items for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "plan_items: members can delete" on public.weekly_plan_items;
create policy "plan_items: members can delete"
  on public.weekly_plan_items for delete
  using (public.is_workspace_member(workspace_id));

-- APPROVAL EVENTS (append-only) ----------------------------------------------

drop policy if exists "approval: members can read" on public.approval_events;
create policy "approval: members can read"
  on public.approval_events for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "approval: members can insert" on public.approval_events;
create policy "approval: members can insert"
  on public.approval_events for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

-- No update / delete policies — approvals are append-only.

-- BACKLOG ITEMS --------------------------------------------------------------

drop policy if exists "backlog: members can read" on public.backlog_items;
create policy "backlog: members can read"
  on public.backlog_items for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "backlog: members can insert" on public.backlog_items;
create policy "backlog: members can insert"
  on public.backlog_items for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "backlog: members can update" on public.backlog_items;
create policy "backlog: members can update"
  on public.backlog_items for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "backlog: members can delete" on public.backlog_items;
create policy "backlog: members can delete"
  on public.backlog_items for delete
  using (public.is_workspace_member(workspace_id));

-- SCHEDULED ITEMS ------------------------------------------------------------

drop policy if exists "scheduled: members can read" on public.scheduled_items;
create policy "scheduled: members can read"
  on public.scheduled_items for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "scheduled: members can insert" on public.scheduled_items;
create policy "scheduled: members can insert"
  on public.scheduled_items for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "scheduled: members can update" on public.scheduled_items;
create policy "scheduled: members can update"
  on public.scheduled_items for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "scheduled: members can delete" on public.scheduled_items;
create policy "scheduled: members can delete"
  on public.scheduled_items for delete
  using (public.is_workspace_member(workspace_id));

-- RISK EVENTS (append-only) --------------------------------------------------

drop policy if exists "risk: members can read" on public.risk_events;
create policy "risk: members can read"
  on public.risk_events for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "risk: members can insert" on public.risk_events;
create policy "risk: members can insert"
  on public.risk_events for insert
  with check (public.is_workspace_member(workspace_id));

-- No update / delete — risk events are append-only.

-- DRAFT VARIANTS -------------------------------------------------------------

drop policy if exists "drafts: members can read" on public.draft_variants;
create policy "drafts: members can read"
  on public.draft_variants for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "drafts: members can insert" on public.draft_variants;
create policy "drafts: members can insert"
  on public.draft_variants for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "drafts: members can update" on public.draft_variants;
create policy "drafts: members can update"
  on public.draft_variants for update
  using (public.is_workspace_member(workspace_id));

drop policy if exists "drafts: members can delete" on public.draft_variants;
create policy "drafts: members can delete"
  on public.draft_variants for delete
  using (public.is_workspace_member(workspace_id));
