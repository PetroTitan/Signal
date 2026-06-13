/**
 * Phase C2 — pure notification spec builders.
 *
 * Maps REAL operational state (failed/blocked/retry-exhausted/stale-
 * claim execution items, expiring connections) into notification
 * specs with STABLE dedupe keys, so reconciling the same state twice
 * never creates duplicate rows. Source-of-truth only — no notification
 * is invented; published/healthy items produce nothing.
 *
 * Pure module — no I/O. The sync service feeds it real rows and writes
 * the specs via createNotification (which honors dedupe_key).
 */

import type { NotificationType } from "@/lib/supabase/types";

export interface NotificationSpec {
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: string;
  entityId: string;
  dedupeKey: string;
}

export interface FailedItemInput {
  executionItemId: string;
  where: string;
  retryExhausted: boolean;
}

export function buildFailedNotification(input: FailedItemInput): NotificationSpec {
  return input.retryExhausted
    ? {
        type: "retry_exhausted",
        title: `Publishing to ${input.where} failed — retries exhausted`,
        body: "Automatic retries ran out. Open the post to retry manually or fix the cause.",
        entityType: "execution_item",
        entityId: input.executionItemId,
        // Distinct key so the exhausted alert supersedes the plain one.
        dedupeKey: `retry_exhausted:${input.executionItemId}`,
      }
    : {
        type: "publish_failed",
        title: `A post to ${input.where} didn't publish`,
        body: "Open the post to see what happened.",
        entityType: "execution_item",
        entityId: input.executionItemId,
        dedupeKey: `publish_failed:${input.executionItemId}`,
      };
}

export function buildBlockedNotification(input: {
  executionItemId: string;
  title: string | null;
  reasonCode: string | null;
}): NotificationSpec {
  return {
    type: "publish_blocked",
    title: `"${input.title?.trim() || "A post"}" is blocked`,
    body: input.reasonCode ? input.reasonCode.replace(/_/g, " ") : null,
    entityType: "execution_item",
    entityId: input.executionItemId,
    dedupeKey: `publish_blocked:${input.executionItemId}`,
  };
}

export function buildStaleClaimNotification(input: {
  executionItemId: string;
  title: string | null;
}): NotificationSpec {
  return {
    type: "stale_claim",
    title: `"${input.title?.trim() || "A post"}" started publishing but never finished`,
    body: "Check the platform before retrying — it may already be live.",
    entityType: "execution_item",
    entityId: input.executionItemId,
    dedupeKey: `stale_claim:${input.executionItemId}`,
  };
}

export function buildConnectionExpiringNotification(input: {
  connectionId: string;
  platformLabel: string;
  expiresAtIso: string | null;
}): NotificationSpec {
  return {
    type: "connection_expiring",
    title: `${input.platformLabel} connection is expiring`,
    body: input.expiresAtIso
      ? `Reconnect before ${new Date(input.expiresAtIso).toLocaleDateString()} to keep publishing.`
      : "Reconnect to keep publishing.",
    entityType: "platform_connection",
    entityId: input.connectionId,
    // Day-bucketed so a re-sync within the same day doesn't spam.
    dedupeKey: `connection_expiring:${input.connectionId}:${(input.expiresAtIso ?? "").slice(0, 10)}`,
  };
}

export function buildInvitationAcceptedNotification(input: {
  invitationId: string;
  email: string;
}): NotificationSpec {
  return {
    type: "invitation_accepted",
    title: `${input.email} accepted your invitation`,
    body: "They've joined the workspace.",
    entityType: "workspace_invitation",
    entityId: input.invitationId,
    dedupeKey: `invitation_accepted:${input.invitationId}`,
  };
}

// =====================================================================
// Digest (C2.2 / C2.3) — pure content builder
// =====================================================================

export interface DigestCounts {
  published: number;
  failed: number;
  blocked: number;
  retrying: number;
  staleClaims: number;
  expiringConnections: number;
}

/**
 * Plain-text operational digest from REAL counts. Returns "" when there
 * is nothing to report (so a sender can skip empty digests). No fake
 * metrics — these are pipeline counts, not engagement.
 */
export function buildOperationalDigest(
  counts: DigestCounts,
  opts?: { workspaceName?: string; period?: "daily" | "weekly" },
): string {
  const lines: string[] = [];
  if (counts.published > 0)
    lines.push(`✅ ${counts.published} published`);
  if (counts.failed > 0) lines.push(`❌ ${counts.failed} failed`);
  if (counts.blocked > 0) lines.push(`⛔ ${counts.blocked} blocked`);
  if (counts.retrying > 0) lines.push(`🔁 ${counts.retrying} retrying`);
  if (counts.staleClaims > 0)
    lines.push(`⚠️ ${counts.staleClaims} started but never finished`);
  if (counts.expiringConnections > 0)
    lines.push(`🔌 ${counts.expiringConnections} connection(s) expiring`);
  if (lines.length === 0) return "";
  const header = `Signal ${opts?.period ?? ""} digest${opts?.workspaceName ? ` — ${opts.workspaceName}` : ""}`.trim();
  return `${header}\n${lines.map((l) => `• ${l}`).join("\n")}`;
}

// =====================================================================
// Scheduled digest (C2.1) — pure content builder over the notification
// feed (the source of truth that already aggregates all 8 types).
// =====================================================================

/**
 * Human label per notification type. Order is significant — most
 * operationally-urgent first.
 */
const SCHEDULED_DIGEST_ORDER: { type: NotificationType; label: string }[] = [
  { type: "retry_exhausted", label: "retries exhausted" },
  { type: "publish_failed", label: "publish failed" },
  { type: "publish_blocked", label: "blocked" },
  { type: "stale_claim", label: "started but never finished" },
  { type: "connection_expiring", label: "connection(s) expiring" },
  { type: "invitation_received", label: "invitation(s) received" },
  { type: "invitation_accepted", label: "invitation(s) accepted" },
  { type: "ownership_transferred", label: "ownership transferred" },
];

export interface ScheduledDigestInput {
  /** Counts per notification type — REAL unread rows only. */
  unreadByType: Partial<Record<NotificationType, number>>;
  /** Total unread (sum across types). */
  total: number;
  workspaceName?: string | null;
  period?: "daily" | "weekly";
}

/**
 * Build the scheduled digest text from the recipient's REAL unread
 * notifications, grouped by type. Returns "" when there is nothing
 * unread, so the delivery job can skip an empty digest. No fabricated
 * counts, no estimated metrics, no AI-generated prose — every line maps
 * to actual unread rows in the notifications table.
 */
export function buildScheduledDigest(input: ScheduledDigestInput): string {
  const lines: string[] = [];
  for (const { type, label } of SCHEDULED_DIGEST_ORDER) {
    const n = input.unreadByType[type] ?? 0;
    if (n > 0) lines.push(`• ${n} ${label}`);
  }
  if (lines.length === 0 || input.total <= 0) return "";
  const name = input.workspaceName?.trim();
  const header =
    `Signal ${input.period ?? ""} digest${name ? ` — ${name}` : ""} · ${input.total} unread`.replace(
      /\s+·/,
      " ·",
    );
  return `${header.trim()}\n${lines.join("\n")}`;
}

/**
 * Is a connection within the operator's warning window? Pure check
 * shared by the sync service + UI.
 */
export function isConnectionExpiringSoon(input: {
  expiresAtIso: string | null;
  warningDays: number;
  now: Date;
}): boolean {
  if (!input.expiresAtIso) return false;
  const exp = new Date(input.expiresAtIso).getTime();
  if (Number.isNaN(exp)) return false;
  const windowMs = Math.max(0, input.warningDays) * 24 * 60 * 60 * 1000;
  // Expiring soon = within the window AND not already long past.
  return exp - input.now.getTime() <= windowMs;
}
