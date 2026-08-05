/**
 * P0.2 — the retry firewall.
 *
 * ONE pure decision function shared by every path that can cause an
 * item to be published again: the scheduler's automatic retry, the
 * operator's "Try again", the weekly-plan "Schedule retry", the MCP
 * scheduling tool, and the manual publish actions.
 *
 * Why one function
 * ----------------
 * PR4 stopped the SCHEDULER from auto-retrying outcomes whose result is
 * unknown. It did not reach the siblings. The audit found four other
 * paths that could re-publish the same item, each gating on
 * `execution_items.status` alone — a status that collapses "the
 * provider refused before writing anything" and "the provider may have
 * published and we never heard back" into the single value `failed`.
 *
 * The evidence to tell them apart was already persisted:
 * `execution_items.metadata.publish_outcome`, written by applyOutcome,
 * carries `{status, reason_code, reason_detail, external_id,
 * external_url}` and survives a requeue. No migration is required —
 * this module only reads what is already there.
 *
 * Outcome classes (locked product semantics)
 * ------------------------------------------
 *   A safe_retry          provider definitely not attempted
 *   B conditional_retry   attempted, confirmed no publication, or a
 *                         transient failure with reliable semantics
 *   C unknown_outcome     dispatched, result unknown
 *   D partial_success     some parts published, final state incomplete
 *   E confirmed_published provider id / permalink / explicit success
 *
 *   A  may retry
 *   B  may retry with backoff
 *   C  never automatically, never by a generic "Try again"
 *   D  never blindly; explicit operator recovery only
 *   E  never
 *
 * This module deliberately does NOT re-decide A vs B. That judgement
 * already lives in `publish-retry-policy.ts`, which the scheduler
 * consults for backoff and attempt budget. Duplicating a 76-member
 * reason-code taxonomy in a second place would recreate the very drift
 * this milestone exists to remove. What this module owns is the
 * firewall: which classes may be retried at all, and by whom.
 *
 * Pure. No I/O. No platform knowledge.
 */

/** Shape persisted at `execution_items.metadata.publish_outcome`. */
export interface PersistedPublishOutcome {
  status?: string | null;
  reason_code?: string | null;
  reason_detail?: string | null;
  external_id?: string | null;
  external_url?: string | null;
}

export type PublishOutcomeClass =
  | "no_prior_attempt"
  | "safe_or_conditional_retry"
  | "unknown_outcome"
  | "partial_success"
  | "confirmed_published";

export interface RetryEligibility {
  outcomeClass: PublishOutcomeClass;
  /** The scheduler may reschedule this automatically. */
  automaticRetryAllowed: boolean;
  /** A generic operator "Try again" / "Schedule retry" may run. */
  operatorRetryAllowed: boolean;
  /**
   * The operator must confirm what actually happened on the platform
   * before anything re-publishes. True only for outcomes where a post
   * may already be live.
   */
  requiresExplicitRecovery: boolean;
  /** Stable code for tests, logs and structured refusals. */
  refusalCode:
    | null
    | "retry_refused_unknown_outcome"
    | "retry_refused_partial_success"
    | "retry_refused_already_published";
  /** Operator-readable explanation. Never blank when a retry is refused. */
  reason: string;
}

/**
 * Reason codes that mean "the provider may have acted, and we cannot
 * prove whether it did".
 *
 * `publish_outcome_unknown` and `publish_partial_success` are the
 * explicit ones introduced by PR4. The publishers emit them from their
 * CREATE catch blocks.
 */
const UNKNOWN_OUTCOME_CODES: ReadonlySet<string> = new Set([
  "publish_outcome_unknown",
]);

const PARTIAL_SUCCESS_CODES: ReadonlySet<string> = new Set([
  "publish_partial_success",
]);

const ALLOWED: Omit<RetryEligibility, "outcomeClass"> = {
  automaticRetryAllowed: true,
  operatorRetryAllowed: true,
  requiresExplicitRecovery: false,
  refusalCode: null,
  reason: "",
};

/**
 * Classify a prior publish attempt and decide who, if anyone, may
 * cause it to run again.
 *
 * `publishOutcome` is null when the item has never been attempted —
 * scheduling a fresh item is not a retry and is always permitted.
 */
export function evaluateRetryEligibility(
  publishOutcome: PersistedPublishOutcome | null | undefined,
): RetryEligibility {
  if (!publishOutcome) {
    return { outcomeClass: "no_prior_attempt", ...ALLOWED };
  }

  const status = (publishOutcome.status ?? "").trim();
  const code = (publishOutcome.reason_code ?? "").trim();
  const externalId = (publishOutcome.external_id ?? "").trim();
  const externalUrl = (publishOutcome.external_url ?? "").trim();

  // E — confirmed published. Provider evidence outranks everything: if
  // we hold an id or permalink, the post exists, whatever the status
  // field says.
  if (status === "published" || externalId.length > 0 || externalUrl.length > 0) {
    return {
      outcomeClass: "confirmed_published",
      automaticRetryAllowed: false,
      operatorRetryAllowed: false,
      requiresExplicitRecovery: false,
      refusalCode: "retry_refused_already_published",
      reason:
        "This item already published. Retrying would post it a second time.",
    };
  }

  // D — partial success. Some parts are live; re-running from the top
  // duplicates them. Resume-from-part is deliberately NOT offered until
  // provider-specific idempotency is proven.
  if (PARTIAL_SUCCESS_CODES.has(code)) {
    return {
      outcomeClass: "partial_success",
      automaticRetryAllowed: false,
      operatorRetryAllowed: false,
      requiresExplicitRecovery: true,
      reason:
        "Part of this post published before the rest failed. Check the platform and finish or remove it by hand — retrying would duplicate the parts that are already live.",
      refusalCode: "retry_refused_partial_success",
    };
  }

  // C — unknown outcome. The request went out; the result never came
  // back. A retry may duplicate a live post.
  if (UNKNOWN_OUTCOME_CODES.has(code)) {
    return {
      outcomeClass: "unknown_outcome",
      automaticRetryAllowed: false,
      operatorRetryAllowed: false,
      requiresExplicitRecovery: true,
      reason:
        "We couldn't confirm whether this published. Check the platform first — retrying could post it twice.",
      refusalCode: "retry_refused_unknown_outcome",
    };
  }

  // A / B — the provider either was not reached or definitively
  // refused. Whether an AUTOMATIC retry actually happens (and with what
  // backoff and attempt budget) remains `publish-retry-policy`'s call;
  // this function only certifies that retrying is permissible.
  return { outcomeClass: "safe_or_conditional_retry", ...ALLOWED };
}

/**
 * Convenience for callers holding a raw `execution_items.metadata` bag.
 * Tolerates the many shapes metadata can take without throwing.
 */
export function readPersistedPublishOutcome(
  metadata: unknown,
): PersistedPublishOutcome | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = (metadata as { publish_outcome?: unknown }).publish_outcome;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as PersistedPublishOutcome;
}

/** Read + classify in one step. */
export function evaluateRetryEligibilityFromMetadata(
  metadata: unknown,
): RetryEligibility {
  return evaluateRetryEligibility(readPersistedPublishOutcome(metadata));
}
