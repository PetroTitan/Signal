"use server";

import { revalidatePath } from "next/cache";
import { updateSettings } from "@/repositories/settings-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { RepositoryError } from "@/repositories/errors";

export interface SettingsActionState {
  ok: boolean;
  error: string | null;
  savedAt?: string;
}

export async function updateRegionAction(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const region = (String(formData.get("region") ?? "").trim() || null) as
    | string
    | null;
  const timezone = (String(formData.get("timezone") ?? "").trim() || null) as
    | string
    | null;
  const language = (String(formData.get("language") ?? "").trim() || null) as
    | string
    | null;

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const next = await updateSettings({
      workspaceId: membership.workspace.id,
      region,
      timezone,
      language,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "settings.updated",
      entityType: "workspace_settings",
      entityId: membership.workspace.id,
      title: "Region settings updated",
      description: `Region: ${next.region ?? "—"} · Timezone: ${next.timezone ?? "—"} · Language: ${next.language ?? "—"}`,
    });
    revalidatePath("/settings");
    revalidatePath("/settings/network");
    revalidatePath("/activity");
    return { ok: true, error: null, savedAt: next.updatedAt };
  } catch (error) {
    const message =
      error instanceof RepositoryError ? error.message : "Failed to update settings.";
    return { ok: false, error: message };
  }
}
