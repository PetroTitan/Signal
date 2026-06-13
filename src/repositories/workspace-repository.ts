import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceRole,
} from "@/lib/supabase/types";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

export interface Workspace {
  id: string;
  name: string;
  slug: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  isPrimary: boolean;
  workspace: Workspace;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMyWorkspaces(): Promise<WorkspaceMembership[]> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id, user_id, role, is_primary, created_at, workspaces(*)")
    // is_primary=true first, then earliest-created. The DB-side ORDER
    // matches the resolver's preference so consumers get a stable list.
    .eq("user_id", user.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) throw fromPostgres(error, "Failed to list workspaces.");

  const rows = (data ?? []) as unknown as Array<
    WorkspaceMemberRow & { workspaces: WorkspaceRow | null }
  >;
  return rows
    .filter((row) => row.workspaces !== null)
    .map((row) => ({
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      isPrimary: row.is_primary,
      workspace: toWorkspace(row.workspaces as WorkspaceRow),
    }));
}

/**
 * Resolves the workspace to use for the current user.
 *
 * Order of preference:
 *   1. The member row marked `is_primary=true` (at most one per user,
 *      enforced by a partial unique index).
 *   2. The earliest-created membership (legacy fallback). Lets users
 *      with a single workspace work without explicitly setting a
 *      primary marker.
 */
export async function getPrimaryWorkspace(): Promise<WorkspaceMembership | null> {
  const list = await listMyWorkspaces();
  if (list.length === 0) return null;
  // listMyWorkspaces already orders is_primary DESC, created_at ASC.
  // Defensive: still scan explicitly in case the order is changed
  // upstream by a future refactor.
  return list.find((m) => m.isPrimary) ?? list[0];
}

/**
 * Mark a workspace as the primary for the authenticated user.
 * Clears any other primary marker the user has (partial unique
 * index would otherwise reject the update). Returns the updated
 * membership row.
 */
export async function setPrimaryWorkspace(input: {
  workspaceId: string;
}): Promise<WorkspaceMembership> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  // Clear existing primary marker (if any) before setting the new one.
  // Two updates instead of one because Postgres applies the unique
  // index after the row update, not after the whole statement.
  const { error: clearErr } = await supabase
    .from("workspace_members")
    .update({ is_primary: false } as never)
    .eq("user_id", user.id)
    .eq("is_primary", true);
  if (clearErr) throw fromPostgres(clearErr, "Failed to clear primary marker.");

  const { error: setErr } = await supabase
    .from("workspace_members")
    .update({ is_primary: true } as never)
    .eq("user_id", user.id)
    .eq("workspace_id", input.workspaceId);
  if (setErr) throw fromPostgres(setErr, "Failed to set primary workspace.");

  const all = await listMyWorkspaces();
  const updated = all.find((m) => m.workspaceId === input.workspaceId);
  if (!updated) throw notFound("Workspace membership");
  return updated;
}

/**
 * Atomically create a workspace + owner membership + settings + initial
 * activity row, all under the authenticated user's session.
 *
 * Uses the `public.bootstrap_workspace(text)` SECURITY DEFINER RPC. The
 * RPC reads `auth.uid()` internally, so the user can only ever create a
 * workspace that belongs to themselves — no service-role key, no RLS
 * weakening. This avoids the `INSERT…RETURNING *` RLS pitfall the
 * previous Node-side path hit (RETURNING gets filtered by the SELECT
 * policy on `workspaces`, which requires `is_workspace_member`, which
 * hasn't been set yet during bootstrap).
 */
export async function createWorkspace(input: {
  name: string;
}): Promise<Workspace> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const { data: workspaceId, error: rpcError } = await supabase.rpc(
    "bootstrap_workspace",
    { workspace_name: input.name } as never,
  );
  if (rpcError || !workspaceId) {
    throw fromPostgres(rpcError, "Failed to create workspace.");
  }

  return getWorkspaceById(workspaceId as unknown as string);
}

export async function renameWorkspace(input: {
  workspaceId: string;
  name: string;
}): Promise<Workspace> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update({ name: input.name } as never)
    .eq("id", input.workspaceId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to rename workspace.");
  return toWorkspace(data as unknown as WorkspaceRow);
}

export async function getWorkspaceById(workspaceId: string): Promise<Workspace> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load workspace.");
  if (!data) throw notFound("Workspace");
  return toWorkspace(data as unknown as WorkspaceRow);
}

// =====================================================================
// Phase F10 — workspace member management (Team Access)
// =====================================================================
//
// The repository functions below back the /settings/team route. RLS
// already enforces the owner-only write contract on workspace_members
// (see phase_c_rls.sql `members: self-insert or owner-insert` and
// `members: owners can delete`), so the cookie-aware client is
// sufficient — no service-role required.
//
// Email → user_id resolution for the add flow lives in a separate
// `auth-user-lookup` module because auth.users is in the `auth`
// schema and requires the Supabase admin API.

/**
 * Per-workspace member row, including the joined timestamp. Distinct
 * from `WorkspaceMembership` which models the calling user's view of
 * a workspace they belong to.
 */
export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  isPrimary: boolean;
  createdAt: string;
}

/**
 * List every membership row for a workspace. Caller must already be
 * a member (RLS enforces the SELECT policy
 * `members: read own rows or fellow members`). Returns rows ordered
 * by created_at ascending so the original creator appears first.
 */
export async function listWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id, user_id, role, is_primary, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list workspace members.");
  return ((data ?? []) as Array<{
    workspace_id: string;
    user_id: string;
    role: WorkspaceRole;
    is_primary: boolean;
    created_at: string;
  }>).map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    isPrimary: row.is_primary,
    createdAt: row.created_at,
  }));
}

/**
 * Returns true when the calling user is an owner of `workspaceId`.
 * Reads through the existing `is_workspace_owner` RLS helper via a
 * single-row probe; the SELECT policy ensures only fellow members
 * see the row, and the role check stays in SQL.
 */
export async function isCallerWorkspaceOwner(
  workspaceId: string,
): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to check workspace ownership.");
  return data !== null;
}

/**
 * Number of `owner`-role members in a workspace. Used by the remove
 * flow to enforce the "never leave a workspace with zero owners"
 * invariant. RLS allows any member to read fellow-member rows, so
 * this works under the cookie-aware client.
 */
export async function countWorkspaceOwners(
  workspaceId: string,
): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("workspace_members")
    .select("user_id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "owner");
  if (error) throw fromPostgres(error, "Failed to count workspace owners.");
  return count ?? 0;
}

/**
 * Check whether a given user_id is already a member of a workspace.
 * Used by the add flow to surface `already_member` without raising a
 * unique-violation error.
 */
export async function isWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to check membership.");
  return data !== null;
}

/**
 * Insert a workspace_members row. RLS gates this to workspace owners
 * (`members: self-insert or owner-insert`). Callers must verify the
 * caller's ownership via `isCallerWorkspaceOwner` before calling so
 * the surface contract reads cleanly (instead of relying on a 401
 * from RLS deep in the repo layer).
 *
 * `role` is constrained at the column level
 * (`role in ('owner', 'admin', 'editor', 'reviewer', 'viewer')`).
 * The default for new members added via the Team page is `editor`,
 * surfaced by the caller — the repo is role-agnostic.
 *
 * `is_primary` is false because the added user already has their
 * own primary workspace (their auto-bootstrapped one); the Team page
 * never reassigns primary.
 */
export async function addWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}): Promise<WorkspaceMember> {
  const supabase = createSupabaseServerClient();
  const insert = {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    role: input.role,
    is_primary: false,
  };
  const { data, error } = await supabase
    .from("workspace_members")
    .insert(insert as never)
    .select("workspace_id, user_id, role, is_primary, created_at")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to add workspace member.");
  const row = data as {
    workspace_id: string;
    user_id: string;
    role: WorkspaceRole;
    is_primary: boolean;
    created_at: string;
  };
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    isPrimary: row.is_primary,
    createdAt: row.created_at,
  };
}

/**
 * Delete a workspace_members row. RLS gates this to workspace owners
 * (`members: owners can delete`).
 *
 * What this DOES:
 *   - removes the user's access to this specific workspace
 *
 * What this DOES NOT do:
 *   - never deletes `auth.users` (the user keeps their Signal account)
 *   - never deletes `workspaces` (the workspace continues to exist)
 *   - never deletes publish_history, execution_items, platform_
 *     connections, or any audit row. Authored-by columns stay intact
 *     because of the `SET NULL` cascade behaviour on those tables —
 *     audit trail is preserved.
 *
 * Callers must verify owner-invariant guards (don't remove the last
 * owner) before calling. This repo function is intentionally low-level.
 */
/**
 * C1.2 — change a member's role. RLS gates this to owners
 * (`members: owners can update`). Callers must enforce role-specific
 * invariants (e.g. never demote the last owner) before calling.
 */
/**
 * C1.4 — per-member activity derived from REAL audit data only
 * (activity_events). One query, aggregated in memory by actor; no
 * invented metrics. `invitedBy` is resolved from the accepted
 * invitation the member came in on (when present).
 */
export interface MemberActivity {
  lastActivityAt: string | null;
  approvalCount: number;
  publishCount: number;
  totalEvents: number;
  invitedBy: string | null;
}

const APPROVAL_EVENT = /approved|approval/i;
const PUBLISH_EVENT = /(item\.completed|post_published|manual_publish\.recorded)/i;

export async function getWorkspaceMemberActivity(
  workspaceId: string,
): Promise<Map<string, MemberActivity>> {
  const supabase = createSupabaseServerClient();
  const out = new Map<string, MemberActivity>();

  // Recent audit events (one bounded query, newest first).
  const { data: events, error } = await supabase
    .from("activity_events")
    .select("actor_user_id, event_type, created_at")
    .eq("workspace_id", workspaceId)
    .not("actor_user_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw fromPostgres(error, "Failed to read member activity.");

  for (const e of (events ?? []) as Array<{
    actor_user_id: string | null;
    event_type: string;
    created_at: string;
  }>) {
    const uid = e.actor_user_id;
    if (!uid) continue;
    const cur = out.get(uid) ?? {
      lastActivityAt: null,
      approvalCount: 0,
      publishCount: 0,
      totalEvents: 0,
      invitedBy: null,
    };
    cur.totalEvents += 1;
    if (!cur.lastActivityAt) cur.lastActivityAt = e.created_at; // first = newest
    if (APPROVAL_EVENT.test(e.event_type)) cur.approvalCount += 1;
    if (PUBLISH_EVENT.test(e.event_type)) cur.publishCount += 1;
    out.set(uid, cur);
  }

  // Resolve invited_by from accepted invitations (best-effort).
  const { data: invites } = await supabase
    .from("workspace_invitations")
    .select("accepted_by, invited_by")
    .eq("workspace_id", workspaceId)
    .eq("status", "accepted");
  for (const inv of (invites ?? []) as Array<{
    accepted_by: string | null;
    invited_by: string | null;
  }>) {
    if (!inv.accepted_by) continue;
    const cur = out.get(inv.accepted_by) ?? {
      lastActivityAt: null,
      approvalCount: 0,
      publishCount: 0,
      totalEvents: 0,
      invitedBy: null,
    };
    cur.invitedBy = inv.invited_by;
    out.set(inv.accepted_by, cur);
  }

  return out;
}

export async function updateMemberRole(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("workspace_members")
    .update({ role: input.role } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId);
  if (error) throw fromPostgres(error, "Failed to update member role.");
}

/**
 * C1.3 — transfer ownership. The target (an existing member) becomes
 * `owner`; the previous owner is demoted to `admin`. Ordering promotes
 * the target FIRST so the workspace is never momentarily owner-less
 * (the zero-owner invariant holds even if the second update fails).
 * Caller verifies the target is a member and confirms intent.
 */
export async function transferOwnership(input: {
  workspaceId: string;
  fromUserId: string;
  toUserId: string;
}): Promise<void> {
  if (input.fromUserId === input.toUserId) return;
  // Promote the successor first (now there are two owners — never zero).
  await updateMemberRole({
    workspaceId: input.workspaceId,
    userId: input.toUserId,
    role: "owner",
  });
  // Then step the previous owner down to admin.
  await updateMemberRole({
    workspaceId: input.workspaceId,
    userId: input.fromUserId,
    role: "admin",
  });
}

export async function removeWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId);
  if (error) throw fromPostgres(error, "Failed to remove workspace member.");
}
