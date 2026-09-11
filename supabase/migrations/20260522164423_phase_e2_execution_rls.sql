-- Phase E2 — Execution Engine RLS.
--
-- Workspace-scoped policies. Members can read; inserts/updates require
-- workspace membership. Append-only tables (execution_logs,
-- execution_attempts inserts) accept inserts from members; updates and
-- deletes are restricted.

set search_path = public;

-- EXECUTION QUEUES ------------------------------------------------------------

alter table public.execution_queues enable row level security;

drop policy if exists "execution_queues: members can read" on public.execution_queues;
create policy "execution_queues: members can read"
  on public.execution_queues for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "execution_queues: members can insert" on public.execution_queues;
create policy "execution_queues: members can insert"
  on public.execution_queues for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists "execution_queues: members can update" on public.execution_queues;
create policy "execution_queues: members can update"
  on public.execution_queues for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy — queues are part of history.

-- EXECUTION ITEMS -------------------------------------------------------------

alter table public.execution_items enable row level security;

drop policy if exists "execution_items: members can read" on public.execution_items;
create policy "execution_items: members can read"
  on public.execution_items for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "execution_items: members can insert" on public.execution_items;
create policy "execution_items: members can insert"
  on public.execution_items for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "execution_items: members can update" on public.execution_items;
create policy "execution_items: members can update"
  on public.execution_items for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy — items are part of history.

-- EXECUTION LOGS --------------------------------------------------------------
--
-- Append-only. Reads + inserts only.

alter table public.execution_logs enable row level security;

drop policy if exists "execution_logs: members can read" on public.execution_logs;
create policy "execution_logs: members can read"
  on public.execution_logs for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "execution_logs: members can insert" on public.execution_logs;
create policy "execution_logs: members can insert"
  on public.execution_logs for insert
  with check (public.is_workspace_member(workspace_id));

-- No UPDATE / DELETE.

-- EXECUTION ATTEMPTS ----------------------------------------------------------
--
-- Append-first; the runner updates the same row to set finished_at /
-- status / error_summary after the attempt resolves. We allow updates
-- but no deletes.

alter table public.execution_attempts enable row level security;

drop policy if exists "execution_attempts: members can read" on public.execution_attempts;
create policy "execution_attempts: members can read"
  on public.execution_attempts for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "execution_attempts: members can insert" on public.execution_attempts;
create policy "execution_attempts: members can insert"
  on public.execution_attempts for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "execution_attempts: members can update" on public.execution_attempts;
create policy "execution_attempts: members can update"
  on public.execution_attempts for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE.
