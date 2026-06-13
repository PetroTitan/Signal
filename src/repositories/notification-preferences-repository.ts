import "server-only";
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
