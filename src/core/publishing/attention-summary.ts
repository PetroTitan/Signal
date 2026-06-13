/**
 * Phase A4 — operator-attention summary (notification foundation).
 *
 * One pure function that turns REAL pipeline state (failed publishes,
 * blocked items, retrying items, stale scheduler claims, expired
 * connections, retry-exhausted items, carry-over counts) into:
 *
 *   1. entries compatible with the existing <NeedsAttentionStrip>
 *      ({ id, message, href, cta, severity }), and
 *   2. a plain-text digest suitable for a future email / Telegram
 *      notification channel.
 *
 * Notification-readiness, not a notification product: there is no
 * email provider in this repo today, and the Telegram bot token is a
 * PUBLISHING credential — wiring it as a notification channel is a
 * product decision that needs explicit approval. This module makes the
 * content source-of-truth-ready so a sender can be attached later with
 * zero re-derivation. (See the Phase A completion report for the
 * follow-up.)
 *
 * Hard rule: every entry is derived from real DB-backed state passed
 * in by the caller. Nothing is invented; published/completed items can
 * never produce an entry because no input category accepts them.
 *
 * Pure module — no I/O, no React.
 */

export type AttentionSeverity = "danger" | "warn" | "info";

export interface AttentionEntry {
  id: string;
  message: string;
  href: string | null;
  cta?: string | null;
  severity: AttentionSeverity;
}

export interface FailedPublishInput {
  id: string;
  /** Operator-facing location, e.g. "r/startups" or "bluesky". */
  where: string;
  executionItemId: string;
  /** True when the retry budget ran out (metadata.retry.exhausted). */
  retryExhausted?: boolean;
}

export interface BlockedItemInput {
  id: string;
  title: string | null;
  reasonCode: string | null;
  executionItemId: string | null;
}

export interface RetryingItemInput {
  id: string;
  title: string | null;
  /** metadata.retry.next_retry_at (ISO) — real persisted state. */
  nextRetryAtIso: string | null;
  attemptCount: number;
  maxAttempts: number;
}

export interface StaleClaimInput {
  id: string;
  title: string | null;
  claimedAtIso: string | null;
}

export interface ExpiredConnectionInput {
  id: string;
  platformLabel: string;
}

export interface AttentionSummaryInput {
  failedPublishes: FailedPublishInput[];
  blockedItems: BlockedItemInput[];
  retryingItems: RetryingItemInput[];
  staleClaims: StaleClaimInput[];
  expiredConnections: ExpiredConnectionInput[];
  /** Unfinished items living in older weekly plans (Phase A6). */
  carryOverCount: number;
  /** Cap on rendered entries (the digest always counts everything). */
  maxEntries?: number;
}

export interface AttentionSummary {
  entries: AttentionEntry[];
  /** Total count across all categories (not capped). */
  totalCount: number;
  counts: {
    failed: number;
    blocked: number;
    retrying: number;
    staleClaims: number;
    expiredConnections: number;
    retryExhausted: number;
    carryOver: number;
  };
  /** Plain-text digest for a future notification sender. Empty string
   *  when there is nothing needing attention. */
  digestText: string;
}

function formatClock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(11, 16) + " UTC";
}

export function summarizeAttentionItems(
  input: AttentionSummaryInput,
): AttentionSummary {
  const entries: AttentionEntry[] = [];

  // Severity order: hard failures first, then warnings, then info.
  for (const f of input.failedPublishes) {
    entries.push({
      id: `fail-${f.id}`,
      message: f.retryExhausted
        ? `A post to ${f.where} failed and automatic retries are exhausted. Open it to retry manually or fix the cause.`
        : `A post to ${f.where} didn't publish. Open it to see what happened.`,
      href: `/execution/items/${f.executionItemId}`,
      cta: "Open post",
      severity: "danger",
    });
  }

  for (const s of input.staleClaims) {
    const since = formatClock(s.claimedAtIso);
    entries.push({
      id: `stale-${s.id}`,
      message: `"${s.title?.trim() || "A post"}" started publishing${since ? ` at ${since}` : ""} and never finished. Check the platform before retrying — it may already be live.`,
      href: `/execution/items/${s.id}`,
      cta: "Inspect",
      severity: "danger",
    });
  }

  for (const b of input.blockedItems) {
    entries.push({
      id: `blocked-${b.id}`,
      message: `"${b.title?.trim() || "A post"}" is blocked${b.reasonCode ? ` (${b.reasonCode.replace(/_/g, " ")})` : ""}. Fix the issue and approve again.`,
      href: b.executionItemId ? `/execution/items/${b.executionItemId}` : "/weekly-plan?tab=queue",
      cta: "Review",
      severity: "danger",
    });
  }

  for (const c of input.expiredConnections) {
    entries.push({
      id: `conn-${c.id}`,
      message: `${c.platformLabel} connection expired. Reconnect to keep publishing.`,
      href: "/accounts",
      cta: `Reconnect ${c.platformLabel}`,
      severity: "warn",
    });
  }

  for (const r of input.retryingItems) {
    const at = formatClock(r.nextRetryAtIso);
    entries.push({
      id: `retry-${r.id}`,
      message: `"${r.title?.trim() || "A post"}" hit a temporary error — retrying automatically${at ? ` around ${at}` : " on the next run"} (attempt ${Math.min(r.attemptCount + 1, r.maxAttempts)} of ${r.maxAttempts}). No action needed unless it keeps failing.`,
      href: `/execution/items/${r.id}`,
      cta: "Details",
      severity: "info",
    });
  }

  if (input.carryOverCount > 0) {
    entries.push({
      id: "carry-over",
      message: `${input.carryOverCount} unfinished item${input.carryOverCount === 1 ? "" : "s"} from previous weeks ${input.carryOverCount === 1 ? "is" : "are"} not in this week's plan.`,
      href: "/weekly-plan",
      cta: "Review",
      severity: "warn",
    });
  }

  const counts = {
    failed: input.failedPublishes.length,
    blocked: input.blockedItems.length,
    retrying: input.retryingItems.length,
    staleClaims: input.staleClaims.length,
    expiredConnections: input.expiredConnections.length,
    retryExhausted: input.failedPublishes.filter((f) => f.retryExhausted).length,
    carryOver: input.carryOverCount,
  };
  const totalCount = entries.length;
  const capped = entries.slice(0, Math.max(1, input.maxEntries ?? 8));

  const digestLines: string[] = [];
  if (counts.failed > 0) digestLines.push(`${counts.failed} failed publish${counts.failed === 1 ? "" : "es"}${counts.retryExhausted > 0 ? ` (${counts.retryExhausted} with retries exhausted)` : ""}`);
  if (counts.staleClaims > 0) digestLines.push(`${counts.staleClaims} publish${counts.staleClaims === 1 ? "" : "es"} started but never finished — manual check needed`);
  if (counts.blocked > 0) digestLines.push(`${counts.blocked} blocked item${counts.blocked === 1 ? "" : "s"}`);
  if (counts.expiredConnections > 0) digestLines.push(`${counts.expiredConnections} expired platform connection${counts.expiredConnections === 1 ? "" : "s"}`);
  if (counts.retrying > 0) digestLines.push(`${counts.retrying} item${counts.retrying === 1 ? "" : "s"} retrying automatically`);
  if (counts.carryOver > 0) digestLines.push(`${counts.carryOver} unfinished item${counts.carryOver === 1 ? "" : "s"} from previous weeks`);

  return {
    entries: capped,
    totalCount,
    counts,
    digestText: digestLines.length > 0 ? `Signal needs attention:\n- ${digestLines.join("\n- ")}` : "",
  };
}
