import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WorkspaceSettingsRow,
  WorkspaceSettingsUpdate,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface WorkspaceSettings {
  workspaceId: string;
  region: string | null;
  timezone: string | null;
  language: string | null;
  demoMode: boolean;
  createdAt: string;
  updatedAt: string;
}

function toSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    workspaceId: row.workspace_id,
    region: row.region,
    timezone: row.timezone,
    language: row.language,
    demoMode: row.demo_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSettings(
  workspaceId: string,
): Promise<WorkspaceSettings | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_settings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load workspace settings.");
  return data ? toSettings(data as unknown as WorkspaceSettingsRow) : null;
}

export async function updateSettings(input: {
  workspaceId: string;
  region?: string | null;
  timezone?: string | null;
  language?: string | null;
  demoMode?: boolean;
}): Promise<WorkspaceSettings> {
  const supabase = createSupabaseServerClient();
  const patch: WorkspaceSettingsUpdate = {};
  if (input.region !== undefined) patch.region = input.region;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.language !== undefined) patch.language = input.language;
  if (input.demoMode !== undefined) patch.demo_mode = input.demoMode;

  const { data, error } = await supabase
    .from("workspace_settings")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update settings.");
  return toSettings(data as unknown as WorkspaceSettingsRow);
}
