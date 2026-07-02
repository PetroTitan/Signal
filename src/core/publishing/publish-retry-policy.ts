/**
 * Phase A3 — transient-failure classification + retry/backoff decisions
 * for the publishing scheduler.
 *
 * Problem
 * -------
 * Before this module, every failed publish outcome was terminal: the
 * execution item moved to `failed`, the plan item was paused, and the
 * operator had to notice + manually resume — even for a provider 502
 * that would have succeeded five minutes later.
 *
 * This module decides, from the REAL outcome (reason code + structured
 * metadata), whether a failure is safely retryable. Only clearly
 * transient failures retry; everything ambiguous stays terminal so the
 * operator sees it. Retrying can never bypass approval: the only state
 * a retry produces is `scheduled`, which the item already held after
 * the operator's original approval. No approval fields are read or
 * written here.
 *
 * Distinct from `src/core/execution-engine/retry-policy.ts` — that
 * module is the Phase E2 dry-run-era advisory helper whose caller
 * supplies its own `transient` flag. This module OWNS the
 * classification (from PublishReasonCode) and the scheduler-cadence
 * backoff (the cron ticks every 5 minutes, so sub-minute backoffs are
 * meaningless).
 *
 * Pure module — no I/O, no Supabase.
 */

import type { PublishOutcome, PublishReasonCode } from "./publishing-types";

// =====================================================================
// Classification
// =====================================================================

/**
 * Reason codes that are transient REGARDLESS of metadata: rate limits
 * clear, networks heal, providers come back.
 */
/**
 * PR4 — outcomes where the publish MIGHT already have landed on the
 * platform. Auto-retrying a non-idempotent create in this state can
 * duplicate the post, so these are NEVER transient regardless of any
 * metadata (http_status etc.). They are terminal: the item fails and
 * the operator is told to check the platform before retrying by hand.
 *
 * Checked FIRST in isTransientPublishFailure so a future edit that adds
 * one of these to a transient set below still can't make it auto-retry.
 */
const OUTCOME_UNCERTAIN: ReadonlySet<PublishReasonCode> =
  new Set<PublishReasonCode>([
    "publish_outcome_unknown",
    "publish_partial_success",
  ]);

const ALWAYS_TRANSIENT: ReadonlySet<PublishReasonCode> = new Set<PublishReasonCode>([
  "platform_rate_limited",
  "x_rate_limited",
  "devto_rate_limited",
  "hashnode_rate_limited",
  "x_network_error",
  "devto_network_error",
  "hashnode_network_error",
  "x_provider_unavailable",
  "devto_provider_unavailable",
  "hashnode_provider_unavailable",
  // Normally surfaces as a transient *skip* (stays scheduled), but if
  // it ever lands as a failed outcome it is still transient by nature.
  "x_token_refresh_transient",
]);

/**
 * Reason codes that are transient ONLY when the structured metadata
 * shows a server-side / network condition. `http_status >= 500` is a
 * provider outage; `http_status === 0` is the adapters' convention for
 * network errors and client-side timeouts (no response received).
 *
 * Deliberately conservative: an absent http_status means "we don't
 * know what happened" → NOT transient (operator review beats a retry
 * loop on an unknown condition).
 */
const TRANSIENT_WITH_5XX_OR_NETWORK: ReadonlySet<PublishReasonCode> =
  new Set<PublishReasonCode>([
    "platform_api_error",
    "x_api_error",
    "devto_api_error",
    "hashnode_api_error",
  ]);

/**
 * Media upload failures are transient only on a clear provider 5xx.
 * `http_status === 0` is NOT enough here — the media path uses 0 for
 * unsupported-MIME and empty-body refusals too, and retrying those can
 * never succeed. (Permanent media conditions — too large, bad format,
 * derivative failed — have their own reason codes and never retry.)
 */
const MEDIA_UPLOAD_CODES: ReadonlySet<PublishReasonCode> =
  new Set<PublishReasonCode>(["media_upload_failed", "x_media_upload_failed"]);

function readHttpStatus(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  const v = metadata?.http_status;
  return typeof v === "number" ? v : null;
}

/**
 * Is this failed outcome safe to retry automatically?
 *
 * NON-transient by design (never auto-retried): credential problems
 * (`session_missing`, `session_expired` after the in-publish refresh
 * already failed, `platform_unauthorized`, `oauth_*`, `*_token_invalid`,
 * `*_token_missing`), validation (`*_validation_error`, `body_too_long`,
 * `missing_*`, `article_*`, `hashnode_*_required`), approval/creative
 * gates (`creative_missing_*`, `approved_shape_stale`), permanent media
 * conditions (`media_too_large_for_platform`,
 * `media_format_unsupported_for_platform`, `media_video_unsupported`,
 * `media_animated_gif_unsupported`, `media_derivative_failed`,
 * `x_media_upload_unavailable`), policy blocks, `duplicate_post`,
 * `platform_not_supported`, and the catch-alls `unknown_error` /
 * `scheduler_exception` (an exception loop must reach a human, not a
 * retry queue).
 */
export function isTransientPublishFailure(
  reasonCode: PublishReasonCode | string,
  metadata?: Record<string, unknown> | null,
): boolean {
  const code = reasonCode as PublishReasonCode;
  // Outcome-uncertain codes can never auto-retry — a retry might
  // duplicate a post that already published. This wins over every
  // transient rule below.
  if (OUTCOME_UNCERTAIN.has(code)) return false;
  if (ALWAYS_TRANSIENT.has(code)) return true;
  const httpStatus = readHttpStatus(metadata);
  if (TRANSIENT_WITH_5XX_OR_NETWORK.has(code)) {
    return httpStatus !== null && (httpStatus >= 500 || httpStatus === 0);
  }
  if (MEDIA_UPLOAD_CODES.has(code)) {
    return httpStatus !== null && httpStatus >= 500;
  }
  return false;
}

// =====================================================================
// Backoff
// =====================================================================

/** First retry waits one tick; then doubles. */
const BASE_BACKOFF_MINUTES = 5;
/** Ceiling so a flapping provider doesn't push retries past an hour. */
const MAX_BACKOFF_MINUTES = 60;

/**
 * Exponential backoff aligned to the 5-minute cron cadence:
 * attempt 1 → 5m, 2 → 10m, 3 → 20m, … capped at 60m.
 *
 * `attemptNumber` is the attempt that just FAILED (1-based).
 */
export function computeRetryBackoffMinutes(attemptNumber: number): number {
  const n = Math.max(1, Math.floor(attemptNumber));
  const minutes = BASE_BACKOFF_MINUTES * 2 ** (n - 1);
  return Math.min(minutes, MAX_BACKOFF_MINUTES);
}

// =====================================================================
// Decision
// =====================================================================

export interface PublishRetryDecisionInput {
  outcome: Pick<PublishOutcome, "status" | "reasonCode" | "metadata">;
  /** execution_items.attempt_count BEFORE this attempt was recorded. */
  attemptCount: number;
  /** execution_items.max_attempts (repository default 3). */
  maxAttempts: number;
  /** Clock injection for deterministic tests. */
  now: Date;
}

export type PublishRetryDecision =
  | {
      retry: true;
      /** attempt_count value to persist (the attempt that just ran). */
      nextAttemptCount: number;
      /** When the scheduler should pick the item up again (ISO). */
      nextRetryAtIso: string;
      backoffMinutes: number;
      reasonCode: string;
    }
  | {
      retry: false;
      /** True when the failure WAS transient but the budget ran out —
       *  the UI surfaces "retries exhausted, action needed". */
      exhausted: boolean;
      nextAttemptCount: number;
      reasonCode: string;
    };

/**
 * Single retry decision for a publish outcome.
 *
 *   - Only `status === "failed"` outcomes are considered. `blocked`
 *     is an operator-action verdict (approval/creative/policy) and
 *     retrying cannot change it. Success/skip never retry.
 *   - Transient + attempts remaining → retry: reschedule with backoff.
 *   - Transient + budget exhausted → terminal, flagged `exhausted`.
 *   - Non-transient → terminal immediately.
 */
export function decidePublishRetry(
  input: PublishRetryDecisionInput,
): PublishRetryDecision {
  const { outcome, attemptCount, maxAttempts, now } = input;
  const reasonCode = outcome.reasonCode ?? "unknown_error";
  const attemptJustRun = attemptCount + 1;

  if (outcome.status !== "failed") {
    return {
      retry: false,
      exhausted: false,
      nextAttemptCount: attemptCount,
      reasonCode,
    };
  }

  const transient = isTransientPublishFailure(
    reasonCode,
    (outcome.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!transient) {
    return {
      retry: false,
      exhausted: false,
      nextAttemptCount: attemptJustRun,
      reasonCode,
    };
  }

  if (attemptJustRun >= Math.max(1, maxAttempts)) {
    return {
      retry: false,
      exhausted: true,
      nextAttemptCount: attemptJustRun,
      reasonCode,
    };
  }

  const backoffMinutes = computeRetryBackoffMinutes(attemptJustRun);
  const nextRetryAtIso = new Date(
    now.getTime() + backoffMinutes * 60_000,
  ).toISOString();
  return {
    retry: true,
    nextAttemptCount: attemptJustRun,
    nextRetryAtIso,
    backoffMinutes,
    reasonCode,
  };
}

/**
 * Shape persisted under `execution_items.metadata.retry` so the UI can
 * show "Retrying — next attempt ≈ HH:MM (2/3)". All fields reflect
 * real DB-backed state; nothing is derived or invented.
 */
export interface RetryMetadata {
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_reason_code: string;
  /** Set true when the transient budget ran out. */
  exhausted?: boolean;
}

export function buildRetryMetadata(
  decision: PublishRetryDecision,
  maxAttempts: number,
): RetryMetadata {
  return {
    attempt_count: decision.nextAttemptCount,
    max_attempts: maxAttempts,
    next_retry_at: decision.retry ? decision.nextRetryAtIso : null,
    last_reason_code: decision.reasonCode,
    ...(decision.retry === false && decision.exhausted
      ? { exhausted: true }
      : {}),
  };
}
