-- Phase E1 — Weekly Operating Contract RLS.
--
-- Workspace-scoped policies for every weekly-contract table. Read is
-- restricted to workspace members; writes additionally require the user
-- to be an owner/admin (matching the "user approves once per week"
-- model — only operators may grant or revoke a contract).
--
-- No service-role-key path. No bypass.

set search_path = public;

-- HELPERS ---------------------------------------------------------------------

-- Reuse the existing is_workspace_member helper (Phase C). For approval
-- writes we additionally check the role through workspace_members.

create or replace function public.weekly_contract_can_approve(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  );
$$;

grant execute on function public.weekly_contract_can_approve(uuid) to authenticated;

-- WEEKLY APPROVAL CONTRACTS ---------------------------------------------------

alter table public.weekly_approval_contracts enable row level security;

drop policy if exists "weekly_contracts: members can read"
  on public.weekly_approval_contracts;
create policy "weekly_contracts: members can read"
  on public.weekly_approval_contracts for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contracts: approvers can insert"
  on public.weekly_approval_contracts;
create policy "weekly_contracts: approvers can insert"
  on public.weekly_approval_contracts for insert
  with check (
    public.weekly_contract_can_approve(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists "weekly_contracts: approvers can update"
  on public.weekly_approval_contracts;
create policy "weekly_contracts: approvers can update"
  on public.weekly_approval_contracts for update
  using (public.weekly_contract_can_approve(workspace_id))
  with check (public.weekly_contract_can_approve(workspace_id));

-- No DELETE policy. Contracts are append-friendly history; archiving
-- happens through status='revoked' or status='expired'.

-- CONTRACT SCOPE TABLES -------------------------------------------------------

alter table public.weekly_contract_accounts enable row level security;

drop policy if exists "weekly_contract_accounts: members can read"
  on public.weekly_contract_accounts;
create policy "weekly_contract_accounts: members can read"
  on public.weekly_contract_accounts for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contract_accounts: approvers can write"
  on public.weekly_contract_accounts;
create policy "weekly_contract_accounts: approvers can write"
  on public.weekly_contract_accounts for insert
  with check (public.weekly_contract_can_approve(workspace_id));

drop policy if exists "weekly_contract_accounts: approvers can delete"
  on public.weekly_contract_accounts;
create policy "weekly_contract_accounts: approvers can delete"
  on public.weekly_contract_accounts for delete
  using (public.weekly_contract_can_approve(workspace_id));

alter table public.weekly_contract_products enable row level security;

drop policy if exists "weekly_contract_products: members can read"
  on public.weekly_contract_products;
create policy "weekly_contract_products: members can read"
  on public.weekly_contract_products for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contract_products: approvers can write"
  on public.weekly_contract_products;
create policy "weekly_contract_products: approvers can write"
  on public.weekly_contract_products for insert
  with check (public.weekly_contract_can_approve(workspace_id));

drop policy if exists "weekly_contract_products: approvers can delete"
  on public.weekly_contract_products;
create policy "weekly_contract_products: approvers can delete"
  on public.weekly_contract_products for delete
  using (public.weekly_contract_can_approve(workspace_id));

alter table public.weekly_contract_platforms enable row level security;

drop policy if exists "weekly_contract_platforms: members can read"
  on public.weekly_contract_platforms;
create policy "weekly_contract_platforms: members can read"
  on public.weekly_contract_platforms for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contract_platforms: approvers can write"
  on public.weekly_contract_platforms;
create policy "weekly_contract_platforms: approvers can write"
  on public.weekly_contract_platforms for insert
  with check (public.weekly_contract_can_approve(workspace_id));

drop policy if exists "weekly_contract_platforms: approvers can delete"
  on public.weekly_contract_platforms;
create policy "weekly_contract_platforms: approvers can delete"
  on public.weekly_contract_platforms for delete
  using (public.weekly_contract_can_approve(workspace_id));

alter table public.weekly_contract_allowed_actions enable row level security;

drop policy if exists "weekly_contract_allowed_actions: members can read"
  on public.weekly_contract_allowed_actions;
create policy "weekly_contract_allowed_actions: members can read"
  on public.weekly_contract_allowed_actions for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contract_allowed_actions: approvers can write"
  on public.weekly_contract_allowed_actions;
create policy "weekly_contract_allowed_actions: approvers can write"
  on public.weekly_contract_allowed_actions for insert
  with check (public.weekly_contract_can_approve(workspace_id));

drop policy if exists "weekly_contract_allowed_actions: approvers can delete"
  on public.weekly_contract_allowed_actions;
create policy "weekly_contract_allowed_actions: approvers can delete"
  on public.weekly_contract_allowed_actions for delete
  using (public.weekly_contract_can_approve(workspace_id));

alter table public.weekly_contract_execution_windows enable row level security;

drop policy if exists "weekly_contract_execution_windows: members can read"
  on public.weekly_contract_execution_windows;
create policy "weekly_contract_execution_windows: members can read"
  on public.weekly_contract_execution_windows for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "weekly_contract_execution_windows: approvers can write"
  on public.weekly_contract_execution_windows;
create policy "weekly_contract_execution_windows: approvers can write"
  on public.weekly_contract_execution_windows for insert
  with check (public.weekly_contract_can_approve(workspace_id));

drop policy if exists "weekly_contract_execution_windows: approvers can delete"
  on public.weekly_contract_execution_windows;
create policy "weekly_contract_execution_windows: approvers can delete"
  on public.weekly_contract_execution_windows for delete
  using (public.weekly_contract_can_approve(workspace_id));

-- EXECUTION AUTHORIZATIONS ----------------------------------------------------
--
-- Members can read the audit trail. Inserts are workspace-scoped and
-- come from the runner running as the authenticated user. No updates,
-- no deletes — this is append-only.

alter table public.execution_authorizations enable row level security;

drop policy if exists "execution_authorizations: members can read"
  on public.execution_authorizations;
create policy "execution_authorizations: members can read"
  on public.execution_authorizations for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "execution_authorizations: members can insert"
  on public.execution_authorizations;
create policy "execution_authorizations: members can insert"
  on public.execution_authorizations for insert
  with check (public.is_workspace_member(workspace_id));
