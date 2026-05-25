/**
 * Phase F1 — publishing policy (the safety gate the runner consults
 * before every live API call).
 *
 * Hard rules:
 *   - publish only for confirmed account + confirmed product
 *   - publish only with a stored, encrypted OAuth access token
 *   - publish only when workspace_settings.execution_mode = 'live'
 *   - publish only when scheduled_for <= now
 *   - never auto-publish unapproved content
 *   - never publish comments / DMs / votes (Reddit text + link only)
 *
 * Contract enforcement: contract enforcement is APPROVAL-time, not
 * publish-time. Bulk approval flows (approveWeeklyPlanAction /
 * approveAndHoldAction) still require an active contract. Per-post
 * approval is contract-free post PR #91. This gate intentionally
 * does NOT block on contract absence.
 */

import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { publishBlocked, publishSkip } from "./publishing-result";

export const PUBLISHING_POLICY_ALLOWED = [
  "Publish a text post on Reddit through the Reddit OAuth API.",
  "Publish a link post on Reddit through the Reddit OAuth API.",
  "Skip an item whose scheduled_for is still in the future.",
  "Record every publish attempt to execution_logs.",
  "Mark the item failed with a reason when the platform returns an error.",
] as const;

export const PUBLISHING_POLICY_BLOCKED = [
  "Reddit comments / DMs / voting / moderation.",
  "X publishing (not implemented in F1).",
  "LinkedIn publishing (not implemented in F1).",
  "Browser-automation publishing.",
  "Cookie / session-token publishing.",
  "Auto-generating content inside Signal — content comes from approved weekly_plan_items only.",
  "Publishing when the account or product is not review_status='confirmed'.",
  "Publishing when execution_mode is 'dry_run'.",
] as const;

/**
 * Operator-friendly inputs the gate consumes. The runner builds this
 * from the workspace's live state before calling `evaluate`.
 */
export interface PolicyContext {
  request: PublishRequest;
  /**
   * Informational only — kept for backwards-compat with callers that
   * already populate it (the scheduler reads `weekly_approval_contracts`
   * and passes the boolean through). The policy gate NO LONGER
   * blocks publishing on contract absence: per-post contract-free
   * publishing is supported end-to-end after the contract-free
   * migration (PR #91). Bulk approval flows still enforce contract
   * at APPROVAL time, not publish time.
   */
  hasActiveContract: boolean;
  accountReviewStatus: string | null;
  productReviewStatus: string | null;
  connectionStatus: string | null;
  hasStoredAccessToken: boolean;
  scheduledFor: string | null;
  nowIso: string;
  publishingEnabled: boolean;
  riskLevel: string | null;
}

/**
 * Pure: returns a PublishOutcome describing the verdict.
 *   - `null` → the gate passes; the caller may proceed to the
 *     platform-specific publisher.
 *   - non-null → either `skipped` (recoverable, will retry) or
 *     `blocked` (terminal, requires operator action).
 */
export function evaluatePublishingPolicy(
  ctx: PolicyContext,
): PublishOutcome | null {
  if (ctx.request.mode === "dry_run") {
    return publishSkip(
      "execution_mode_dry_run",
      "Workspace is in dry-run mode; the publisher records the attempt without calling the platform.",
    );
  }
  if (!ctx.publishingEnabled) {
    return publishBlocked(
      "publishing_disabled",
      "Live publishing is disabled for this workspace.",
    );
  }
  // NOTE: contract-free per-post publishing (PR #91) made weekly
  // contracts optional. The publish-time gate that previously
  // blocked on `!hasActiveContract` is intentionally removed —
  // contract enforcement lives at APPROVAL time
  // (approveWeeklyPlanAction / approveAndHoldAction). Removing this
  // gate is what unblocked Bluesky items scheduled contract-free.
  if (ctx.accountReviewStatus !== "confirmed") {
    return publishBlocked(
      "account_not_confirmed",
      `Account review_status must be 'confirmed' (is '${ctx.accountReviewStatus ?? "unknown"}').`,
    );
  }
  if (
    ctx.productReviewStatus !== null &&
    ctx.productReviewStatus !== "confirmed"
  ) {
    return publishBlocked(
      "product_not_confirmed",
      `Product review_status must be 'confirmed' (is '${ctx.productReviewStatus}').`,
    );
  }
  if (ctx.connectionStatus !== "connected") {
    return publishBlocked(
      "oauth_not_connected",
      `OAuth connection must be 'connected' (is '${ctx.connectionStatus ?? "missing"}').`,
    );
  }
  if (!ctx.hasStoredAccessToken) {
    return publishBlocked(
      "oauth_token_not_stored",
      "OAuth flow completed but no encrypted access token is stored. TOKEN_ENCRYPTION_KEY may be unset.",
    );
  }
  if (ctx.riskLevel === "blocked") {
    return publishBlocked(
      "risk_level_blocked",
      "Item risk level is 'blocked'.",
    );
  }
  if (ctx.scheduledFor && new Date(ctx.scheduledFor).getTime() > new Date(ctx.nowIso).getTime()) {
    return publishSkip(
      "scheduled_in_future",
      `Scheduled for ${ctx.scheduledFor}; will retry after that time.`,
    );
  }
  return null;
}
