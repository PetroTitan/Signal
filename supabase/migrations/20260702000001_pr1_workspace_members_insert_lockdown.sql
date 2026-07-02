-- =====================================================================
-- PR1 — Critical RLS fix: workspace_members INSERT lockdown
-- =====================================================================
--
-- Problem
-- -------
-- The prior INSERT policy (20260522000002_phase_c_rls.sql) was:
--
--   with check (
--     (user_id = auth.uid())
--     or public.is_workspace_owner(workspace_id)
--   );
--
-- The `user_id = auth.uid()` disjunct let ANY authenticated user insert
-- a membership row for THEMSELVES into ANY workspace_id — with any role,
-- including 'owner' (the column CHECK permits it). Using the public
-- NEXT_PUBLIC_SUPABASE_ANON_KEY and their own JWT, an attacker could
-- POST directly to /rest/v1/workspace_members and join any victim
-- workspace, then read/write all of that tenant's data via
-- is_workspace_member. This is a full cross-tenant takeover.
--
-- Fix
-- ---
-- Only a workspace OWNER may insert members. Legitimate joins that are
-- not owner-driven never used this policy branch — they run through
-- SECURITY DEFINER RPCs that bypass RLS entirely:
--   * public.bootstrap_workspace()          — workspace creation; the
--       creator is inserted as owner (20260522020001).
--   * public.accept_workspace_invitation()  — invitee is inserted at the
--       invited role (20260616000001).
-- The owner "add member" path (repositories/workspace-repository.ts
-- addWorkspaceMember) already relies on the is_workspace_owner branch,
-- so it is unaffected.
--
-- This is a forward-only migration; it does not edit the original policy
-- definition. Owner-only is intentional for this hotfix — broadening to
-- owner-or-admin is deferred to a separate permission/RLS PR (it needs
-- an is_workspace_admin helper plus a WITH CHECK that prevents an admin
-- inserting role='owner').
--
-- No table/column/enum change. Policy-only.

drop policy if exists "members: self-insert or owner-insert" on public.workspace_members;

create policy "members: owner-insert only"
  on public.workspace_members for insert
  with check (public.is_workspace_owner(workspace_id));
