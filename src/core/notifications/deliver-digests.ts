import "server-only";
/**
 * C2.1 — scheduled notification digest delivery.
 *
 * Runs from the cron route `/api/notifications/digest` (cron-secret
 * gated). For each recipient whose notification_preferences match the
 * requested cadence, it builds a digest from their REAL unread
 * notifications (the notifications table is the source of truth that
 * already aggregates every type) and delivers it over their enabled
 * channels via the Phase C sender abstraction.
 *
 * Invariants:
 *   - NEVER mutates notification status (no auto mark-read). Idempotency
 *     comes from the cadence window of the cron schedule, not from
 *     flipping read state.
 *   - NEVER throws for one recipient — failures are captured per
 *     recipient so one bad row can't sink the whole job.
 *   - NEVER invents content — empty unread → the recipient is skipped.
 *   - Touches NOTHING in the publishing scheduler / execution items /
 *     publish history / adapters. Delivery only.
 *
 * All I/O is injected via `DigestDeps` so the orchestration is pure and
 * unit-testable; `buildLiveDigestDeps` wires the real repositories +
 * senders for the route.
 */

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import {
  countUnreadNotificationsByType,
} from "@/repositories/notification-repository";
import {
  listNotificationPreferencesByCadence,
  type DigestRecipientPreference,
} from "@/repositories/notification-preferences-repository";
import { createEmailSender, createTelegramSender, type NotificationSender } from "./notification-sender";
import { buildScheduledDigest } from "./notification-builder";
import type { NotificationType } from "@/lib/supabase/types";

export type DigestCadenceWindow = "daily" | "weekly";

export type ChannelDeliveryStatus =
  | "sent"
  | "skipped_disabled"
  | "skipped_not_configured"
  | "failed";

export type RecipientDeliveryStatus =
  | "sent"
  | "skipped_no_preferences"
  | "skipped_channel_disabled"
  | "skipped_sender_not_configured"
  | "skipped_empty"
  | "failed";

export interface ChannelResult {
  channel: "telegram" | "email";
  status: ChannelDeliveryStatus;
  detail: string;
}

export interface RecipientResult {
  workspaceId: string;
  userId: string;
  status: RecipientDeliveryStatus;
  unreadTotal: number;
  channels: ChannelResult[];
}

export interface DigestJobResult {
  ok: true;
  cadence: DigestCadenceWindow;
  ranAt: string;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Persistent delivery logging is deferred (no delivery-log table);
   *  this structured result is the job's audit trail. */
  deliveryLog: "structured_result_only";
  results: RecipientResult[];
}

export interface DigestDeps {
  listPreferences: (
    cadence: DigestCadenceWindow,
  ) => Promise<DigestRecipientPreference[]>;
  countUnreadByType: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ byType: Partial<Record<NotificationType, number>>; total: number }>;
  makeTelegramSender: () => NotificationSender;
  makeEmailSender: () => NotificationSender;
}

function channelStatusFromSend(code: "sent" | "not_configured" | "error"): ChannelDeliveryStatus {
  if (code === "sent") return "sent";
  if (code === "not_configured") return "skipped_not_configured";
  return "failed";
}

/** Derive the recipient roll-up from its per-channel results. */
function rollUp(channels: ChannelResult[]): RecipientDeliveryStatus {
  if (channels.some((c) => c.status === "sent")) return "sent";
  if (channels.some((c) => c.status === "failed")) return "failed";
  // Everything we attempted was a "not configured" no-op.
  return "skipped_sender_not_configured";
}

/**
 * Deliver digests for one cadence window. Pure orchestration over the
 * injected deps. Never throws.
 */
export async function deliverDigests(
  cadence: DigestCadenceWindow,
  deps: DigestDeps,
  now: Date = new Date(),
): Promise<DigestJobResult> {
  const results: RecipientResult[] = [];
  let recipients: DigestRecipientPreference[] = [];
  try {
    recipients = await deps.listPreferences(cadence);
  } catch (err) {
    console.error("[deliver-digests] listPreferences failed", err);
    recipients = [];
  }

  for (const pref of recipients) {
    try {
      // Defensive: the query already filters by cadence, but never
      // deliver to a row that doesn't match the window we're running.
      if (pref.digestCadence !== cadence) continue;

      const enabledChannels: ("telegram" | "email")[] = [];
      if (pref.telegramEnabled) enabledChannels.push("telegram");
      if (pref.emailEnabled) enabledChannels.push("email");

      if (enabledChannels.length === 0) {
        results.push({
          workspaceId: pref.workspaceId,
          userId: pref.userId,
          status: "skipped_channel_disabled",
          unreadTotal: 0,
          channels: [],
        });
        continue;
      }

      const { byType, total } = await deps.countUnreadByType(
        pref.workspaceId,
        pref.userId,
      );
      const text = buildScheduledDigest({
        unreadByType: byType,
        total,
        workspaceName: pref.workspaceName,
        period: cadence,
      });
      if (!text) {
        results.push({
          workspaceId: pref.workspaceId,
          userId: pref.userId,
          status: "skipped_empty",
          unreadTotal: total,
          channels: [],
        });
        continue;
      }

      const channels: ChannelResult[] = [];
      for (const channel of enabledChannels) {
        const sender =
          channel === "telegram" ? deps.makeTelegramSender() : deps.makeEmailSender();
        const res = await sender.send(text);
        channels.push({
          channel,
          status: channelStatusFromSend(res.code),
          detail: res.detail,
        });
      }

      results.push({
        workspaceId: pref.workspaceId,
        userId: pref.userId,
        status: rollUp(channels),
        unreadTotal: total,
        channels,
      });
    } catch (err) {
      // One recipient failing must never sink the job.
      console.error(
        "[deliver-digests] recipient delivery failed (non-fatal)",
        pref.workspaceId,
        pref.userId,
        err,
      );
      results.push({
        workspaceId: pref.workspaceId,
        userId: pref.userId,
        status: "failed",
        unreadTotal: 0,
        channels: [],
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return {
    ok: true,
    cadence,
    ranAt: now.toISOString(),
    processed: results.length,
    sent,
    failed,
    skipped: results.length - sent - failed,
    deliveryLog: "structured_result_only",
    results,
  };
}

/**
 * Wire the real repositories + senders. Returns null when the
 * service-role client is unavailable (the cron runs as the system, so
 * it cannot fall back to a cookie-aware client).
 */
export function buildLiveDigestDeps(): DigestDeps | null {
  const db = createSupabaseServiceRoleClient();
  if (!db) return null;
  return {
    listPreferences: (cadence) => listNotificationPreferencesByCadence(cadence, db),
    countUnreadByType: (workspaceId, userId) =>
      countUnreadNotificationsByType(workspaceId, userId, db),
    // PR5: the scheduled digest runs across ALL workspaces, so it must
    // NOT route to a single global Telegram chat (cross-workspace leak).
    // No per-recipient chat id exists yet, so we pass none — the sender
    // becomes a `not_configured` no-op and Telegram delivery is reported
    // as `skipped_not_configured`, never sent. Restore Telegram here by
    // threading a verified per-(workspace,user) chat id once the
    // notification_preferences migration adds one.
    makeTelegramSender: () => createTelegramSender(),
    makeEmailSender: () => createEmailSender(),
  };
}
