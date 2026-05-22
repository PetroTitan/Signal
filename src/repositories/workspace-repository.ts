import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WorkspaceInsert,
  WorkspaceMemberInsert,
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceRole,
  WorkspaceSettingsInsert,
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

export async function createWorkspace(input: {
  name: string;
}): Promise<Workspace> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const workspaceInsert: WorkspaceInsert = {
    name: input.name,
    created_by: user.id,
  };
  const { data: workspaceData, error: insertError } = await supabase
    .from("workspaces")
    .insert(workspaceInsert as never)
    .select("*")
    .single();
  if (insertError || !workspaceData) {
    throw fromPostgres(insertError, "Failed to create workspace.");
  }
  const workspace = workspaceData as unknown as WorkspaceRow;

  const memberInsert: WorkspaceMemberInsert = {
    workspace_id: workspace.id,
    user_id: user.id,
    role: "owner",
  };
  const { error: memberError } = await supabase
    .from("workspace_members")
    .insert(memberInsert as never);
  if (memberError) {
    throw fromPostgres(memberError, "Failed to add workspace member.");
  }

  const settingsInsert: WorkspaceSettingsInsert = {
    workspace_id: workspace.id,
    demo_mode: false,
  };
  const { error: settingsError } = await supabase
    .from("workspace_settings")
    .insert(settingsInsert as never);
  if (settingsError) {
    throw fromPostgres(settingsError, "Failed to seed workspace settings.");
  }

  return toWorkspace(workspace);
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
