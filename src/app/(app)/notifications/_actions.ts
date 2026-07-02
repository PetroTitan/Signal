"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  markAllNotificationsRead,
  markNotification,
} from "@/repositories/notification-repository";
import { upsertNotificationPreferences } from "@/repositories/notification-preferences-repository";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";
import type { DigestCadence, NotificationStatus } from "@/lib/supabase/types";

async function callerUserId(): Promise<string | null> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function markNotificationAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim() as NotificationStatus;
  if (!id || !["read", "archived", "unread"].includes(status)) {
    return actionFail("Missing notification or status.");
  }
  try {
    await markNotification({ id, status }); // RLS restricts to own rows
    revalidatePath("/notifications");
    return actionOk();
  } catch (err) {
    console.error("[notifications] markNotificationAction failed", err);
    return actionFail("Could not update the notification.");
  }
}

export async function markAllReadAction(
  _prev: ActionResult,
): Promise<ActionResult> {
  try {
    const membership = await getPrimaryWorkspace();
    const userId = await callerUserId();
    if (!membership || !userId) return actionFail("Not authorized.");
    await markAllNotificationsRead({ workspaceId: membership.workspace.id, userId });
    revalidatePath("/notifications");
    return actionOk();
  } catch (err) {
    console.error("[notifications] markAllReadAction failed", err);
    return actionFail("Could not mark all read.");
  }
}

export async function updateNotificationPreferencesAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const membership = await getPrimaryWorkspace();
    const userId = await callerUserId();
    if (!membership || !userId) return actionFail("Not authorized.");
    const cadence = String(formData.get("digest_cadence") ?? "disabled") as DigestCadence;
    const warnDaysRaw = Number(formData.get("connection_warning_days") ?? 3);
    await upsertNotificationPreferences({
      workspaceId: membership.workspace.id,
      userId,
      emailEnabled: formData.get("email_enabled") === "on",
      telegramEnabled: formData.get("telegram_enabled") === "on",
      digestCadence: (["daily", "weekly", "disabled"] as string[]).includes(cadence)
        ? cadence
        : "disabled",
      connectionWarningDays: Number.isFinite(warnDaysRaw)
        ? Math.max(0, Math.min(30, Math.round(warnDaysRaw)))
        : 3,
    });
    revalidatePath("/notifications");
    return actionOk();
  } catch (err) {
    console.error("[notifications] updateNotificationPreferencesAction failed", err);
    return actionFail("Could not save preferences.");
  }
}

export type SendDigestResult = ActionResult<{ detail: string }>;

/**
 * C2.2/C2.3 — send the operational digest now via the operator's
 * enabled channels (real counts only; vendor-neutral sender). When no
 * channel is enabled/configured, reports that without sending.
 */
export async function sendDigestNowAction(
  _prev: SendDigestResult,
): Promise<SendDigestResult> {
  try {
    const membership = await getPrimaryWorkspace();
    const userId = await callerUserId();
    if (!membership || !userId) return actionFail("Not authorized.");
    const workspaceId = membership.workspace.id;

    const [{ getNotificationPreferences }, { gatherDigestCounts }] = await Promise.all([
      import("@/repositories/notification-preferences-repository"),
      import("@/core/notifications/digest-data"),
    ]);
    const prefs = await getNotificationPreferences(workspaceId, userId);
    const counts = await gatherDigestCounts(workspaceId, {
      periodHours: prefs.digestCadence === "weekly" ? 24 * 7 : 24,
      userId,
    });
    const { buildOperationalDigest } = await import(
      "@/core/notifications/notification-builder"
    );
    const text = buildOperationalDigest(counts, {
      workspaceName: membership.workspace.name,
      period: prefs.digestCadence === "weekly" ? "weekly" : "daily",
    });
    if (!text) return actionOk({ detail: "Nothing to report right now." });

    const results: string[] = [];
    const { createTelegramSender, createEmailSender } = await import(
      "@/core/notifications/notification-sender"
    );
    if (prefs.telegramEnabled) {
      // Manual, operator-initiated "send me a test digest" for the
      // operator's OWN workspace. Explicitly target the operator-owned
      // TELEGRAM_DIGEST_CHAT_ID here (a single-operator test channel);
      // createTelegramSender no longer falls back to it implicitly, so
      // the scheduled cron path can never leak to it. When unset, the
      // sender reports not_configured and nothing is sent.
      const testChatId = process.env.TELEGRAM_DIGEST_CHAT_ID?.trim() || null;
      results.push((await createTelegramSender(testChatId).send(text)).detail);
    }
    if (prefs.emailEnabled) {
      results.push((await createEmailSender().send(text)).detail);
    }
    if (results.length === 0) {
      return actionOk({ detail: "No channels enabled — preview only." });
    }
    return actionOk({ detail: results.join(" ") });
  } catch (err) {
    console.error("[notifications] sendDigestNowAction failed", err);
    return actionFail("Could not send the digest.");
  }
}
