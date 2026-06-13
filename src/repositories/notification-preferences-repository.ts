import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  DigestCadence,
  NotificationPreferencesInsert,
  NotificationPreferencesRow,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

/**
 * Phase C2.4 — per-user notification preferences (own row only via RLS).
 */

export interface NotificationPreferences {
  workspaceId: string;
  userId: string;
  emailEnabled: boolean;
  telegramEnabled: boolean;
  digestCadence: DigestCadence;
  connectionWarningDays: number;
}

const DEFAULTS: Omit<NotificationPreferences, "workspaceId" | "userId"> = {
  emailEnabled: false,
  telegramEnabled: false,
  digestCadence: "disabled",
  connectionWarningDays: 3,
};

export async function getNotificationPreferences(
  workspaceId: string,
  userId: string,
): Promise<NotificationPreferences> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to read notification preferences.");
  if (!data) return { workspaceId, userId, ...DEFAULTS };
  const row = data as unknown as NotificationPreferencesRow;
  return {
    workspaceId,
    userId,
    emailEnabled: row.email_enabled,
    telegramEnabled: row.telegram_enabled,
    digestCadence: row.digest_cadence,
    connectionWarningDays: row.connection_warning_days,
  };
}

export interface DigestRecipientPreference {
  workspaceId: string;
  userId: string;
  workspaceName: string | null;
  emailEnabled: boolean;
  telegramEnabled: boolean;
  digestCadence: DigestCadence;
}

/**
 * C2.1 — every preference row matching the given digest cadence, across
 * all workspaces. Used by the scheduled digest cron, which runs as the
 * system (no operator cookie), so it REQUIRES the service-role client.
 * Rows whose cadence is 'disabled' are never returned. Read-only.
 */
export async function listNotificationPreferencesByCadence(
  cadence: "daily" | "weekly",
  db: SupabaseClient,
): Promise<DigestRecipientPreference[]> {
  const { data, error } = await db
    .from("notification_preferences")
    .select(
      "workspace_id, user_id, email_enabled, telegram_enabled, digest_cadence, workspaces(name)",
    )
    .eq("digest_cadence", cadence);
  if (error) throw fromPostgres(error, "Failed to list digest recipients.");
  return (
    (data ?? []) as unknown as Array<{
      workspace_id: string;
      user_id: string;
      email_enabled: boolean;
      telegram_enabled: boolean;
      digest_cadence: DigestCadence;
      workspaces: { name: string | null } | { name: string | null }[] | null;
    }>
  ).map((row) => {
    const ws = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
    return {
      workspaceId: row.workspace_id,
      userId: row.user_id,
      workspaceName: ws?.name ?? null,
      emailEnabled: row.email_enabled,
      telegramEnabled: row.telegram_enabled,
      digestCadence: row.digest_cadence,
    };
  });
}

export async function upsertNotificationPreferences(input: {
  workspaceId: string;
  userId: string;
  emailEnabled: boolean;
  telegramEnabled: boolean;
  digestCadence: DigestCadence;
  connectionWarningDays: number;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const row: NotificationPreferencesInsert = {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    email_enabled: input.emailEnabled,
    telegram_enabled: input.telegramEnabled,
    digest_cadence: input.digestCadence,
    connection_warning_days: input.connectionWarningDays,
  };
  const { error } = await supabase
    .from("notification_preferences")
    .upsert(row as never, { onConflict: "workspace_id,user_id" });
  if (error) throw fromPostgres(error, "Failed to save notification preferences.");
}
