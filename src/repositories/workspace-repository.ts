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
