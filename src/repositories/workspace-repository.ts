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
    .select("workspace_id, user_id, role, created_at, workspaces(*)")
    .eq("user_id", user.id)
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
      workspace: toWorkspace(row.workspaces as WorkspaceRow),
    }));
}

export async function getPrimaryWorkspace(): Promise<WorkspaceMembership | null> {
  const list = await listMyWorkspaces();
  return list[0] ?? null;
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
