/**
 * Provider outcome → member status, and what happens next.
 *
 * Pure, client-safe, no I/O. This is the failure policy in one place,
 * so "what does a 5xx do" has exactly one answer rather than one per
 * call site.
 *
 * INHERITED RULE
 * --------------
 * The relationship subsystem's central rule carries over unchanged: an
 * outcome Signal could not read is NOT a failure and is NOT retried
 * blindly. `createRecord` is not idempotent — a retry of a request that
 * actually succeeded leaves two follow records for one account, one of
 * which Signal has no row for. So an ambiguous result reconciles
 * against relationship truth before anything else happens.
 *
 * WHAT IS DIFFERENT HERE
 * ----------------------
 * A campaign runs unattended, so "leave it for the operator" cannot be
 * the answer to everything. The resolution is that reconciliation is
 * allowed to CONCLUDE automatically — if the provider says the follow
 * exists, the member is `succeeded` and no second mutation is sent —
 * but a reconciliation that comes back unknown still stops rather than
 * guessing.
 */

export type CampaignOutcomeKind =
  | "succeeded"
  /** Dry run: every step ran EXCEPT the provider call. */
  | "dry_run"
  | "already_following"
  | "actor_not_found"
  | "ineligible"
  | "retryable_transport_failure"
  | "rate_limited"
  | "authentication_expired"
  | "structural_provider_failure"
  | "cancelled";

/** What the worker does after this outcome. */
export type NextAction =
  /** Keep going with the next member. */
  | { kind: "continue" }
  /** Stop this chunk; the run may continue later today. */
  | { kind: "stop_run"; reason: string; resumeAfter?: Date | null }
  /** Stop the whole campaign; it needs a human. */
  | { kind: "stop_campaign"; campaignStatus: CampaignHaltStatus; reason: string };

export type CampaignHaltStatus =
  | "reauthorization_required"
  | "rate_limited"
  | "failed";

/** The member row's resulting status. */
export type MemberTerminalStatus =
  | "succeeded"
  | "already_following"
  | "protected"
  | "skipped"
  | "retryable"
  | "failed_structural"
  | "cancelled";

export interface OutcomeDecision {
  kind: CampaignOutcomeKind;
  memberStatus: MemberTerminalStatus;
  /** Does this consume a unit of the day's quota? */
  consumesQuota: boolean;
  /** Does this count as a success for the success-rate breaker? */
  countsAsSuccess: boolean;
  /** Does this count as a failure for the consecutive-failure breaker? */
  countsAsFailure: boolean;
  next: NextAction;
  /** Whether the member may be claimed again later. */
  retryable: boolean;
}

/** Attempts before a retryable member becomes terminal. */
export const MAX_MEMBER_ATTEMPTS = 4;

/** Base backoff. Doubles per attempt, with jitter, capped. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Backoff for the next attempt.
 *
 * Jitter here is NOT traffic disguising — it exists so that a hundred
 * members that failed in the same chunk do not all retry in the same
 * millisecond and recreate the burst that failed. It is applied to
 * retry timing only, never to the spacing between normal requests,
 * which stays the fixed `INTER_REQUEST_MS` the manual path uses.
 */
export function backoffDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1));
  const capped = Math.min(exponential, BACKOFF_MAX_MS);
  // ±20% spread.
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(1_000, Math.round(capped + jitter));
}

export interface ClassifyInput {
  kind: CampaignOutcomeKind;
  /** Attempts already made against this member, including this one. */
  attemptCount: number;
  /** When the provider says it is safe to resume, from a 429. */
  resumeAfter?: Date | null;
}

/**
 * The single failure policy.
 *
 * Every branch is explicit about all five consequences, so no call site
 * has to infer, for example, whether `already_following` costs quota.
 */
export function classifyOutcome(input: ClassifyInput): OutcomeDecision {
  const { kind, attemptCount } = input;

  switch (kind) {
    case "succeeded":
      return {
        kind,
        memberStatus: "succeeded",
        consumesQuota: true,
        countsAsSuccess: true,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "dry_run":
      // A dry run makes no request at all, so it creates nothing,
      // consumes nothing, and proves nothing about the provider. It is
      // recorded as `skipped` rather than `succeeded` precisely so a
      // dry run can never be mistaken for real progress.
      return {
        kind,
        memberStatus: "skipped",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "already_following":
      // Explicitly NOT quota-consuming: no record was created, so it
      // must not cost the operator a follow they never made. It is also
      // not a failure — the desired state already holds.
      return {
        kind,
        memberStatus: "already_following",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "actor_not_found":
      // The account is gone or was never resolvable. Terminal for this
      // member and not a provider fault, so it does not trip the
      // failure breaker — a queue imported months ago will legitimately
      // contain deleted accounts.
      return {
        kind,
        memberStatus: "skipped",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "ineligible":
      // Blocked, protected, or otherwise not followable. Terminal,
      // neutral, and never retried.
      return {
        kind,
        memberStatus: "protected",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "retryable_transport_failure": {
      const exhausted = attemptCount >= MAX_MEMBER_ATTEMPTS;
      return {
        kind,
        // Once the bounded attempts are spent the member becomes
        // terminal. "Retry forever" is not a policy.
        memberStatus: exhausted ? "failed_structural" : "retryable",
        // An exhausted member consumed real attempts, so it consumes
        // quota; one that will be retried has not finished yet.
        consumesQuota: exhausted,
        countsAsSuccess: false,
        countsAsFailure: true,
        next: { kind: "continue" },
        retryable: !exhausted,
      };
    }

    case "rate_limited":
      // Stop claiming immediately and resume no earlier than the reset
      // the provider reported. The member itself was not attempted.
      return {
        kind,
        memberStatus: "retryable",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: {
          kind: "stop_run",
          reason:
            "Bluesky rate-limited this account. Processing stopped and will resume no earlier than the reset time Bluesky reported.",
          resumeAfter: input.resumeAfter ?? null,
        },
        retryable: true,
      };

    case "authentication_expired":
      // The session is dead. Nothing further can succeed, and retrying
      // would only burn createSession budget (300/day per account).
      return {
        kind,
        memberStatus: "retryable",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: {
          kind: "stop_campaign",
          campaignStatus: "reauthorization_required",
          reason:
            "Bluesky rejected this identity's session. The campaign is stopped until the identity is reconnected; no further follows will be attempted.",
        },
        retryable: true,
      };

    case "structural_provider_failure":
      // A 4xx the provider raised about THIS request — a malformed
      // record, a subject it will not accept. Terminal for the MEMBER,
      // with the provider's reason kept on it, and it counts toward the
      // consecutive-failure breaker.
      //
      // It does NOT stop the campaign. It used to: one member's
      // "InvalidRequest" marked the whole campaign `failed` and left
      // every queued member behind it stranded until an operator
      // noticed. A systemic problem shows up as MANY structural
      // failures in a row, and that is what the breaker is for.
      return {
        kind,
        memberStatus: "failed_structural",
        consumesQuota: true,
        countsAsSuccess: false,
        countsAsFailure: true,
        next: { kind: "continue" },
        retryable: false,
      };

    case "cancelled":
      return {
        kind,
        memberStatus: "cancelled",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };
  }
}

/**
 * Map a graph-client failure onto a campaign outcome.
 *
 * The relationship client already classifies transport, auth, rate
 * limit and provider errors; this is the thin adapter, kept separate so
 * the policy above stays free of provider shapes.
 */
export function outcomeFromGraphFailure(failure: {
  kind: "network" | "rate_limited" | "auth" | "not_found" | "provider_error";
  status: number;
}): CampaignOutcomeKind {
  switch (failure.kind) {
    case "auth":
      return "authentication_expired";
    case "rate_limited":
      return "rate_limited";
    case "not_found":
      return "actor_not_found";
    case "network":
      return "retryable_transport_failure";
    case "provider_error":
      // 5xx is the provider having a bad moment — retryable within the
      // bounded policy. Anything else is structural and stops.
      return failure.status >= 500
        ? "retryable_transport_failure"
        : "structural_provider_failure";
  }
}

// =====================================================================
// Rejected BEFORE writing, versus ambiguous
// =====================================================================
//
// PRODUCTION, 2026-09-14. After provider intent, every non-success was
// filed as `reconciliation_required`. That is right for a request whose
// response was LOST — a network error, a 5xx, a 2xx we could not parse:
// the record may exist, and only a read can say. It is wrong for a
// request the provider REFUSED before touching the repository: HTTP 400
// {"error":"ExpiredToken"}, a 429, a structural 4xx. Nothing was
// written, so relationship truth is `not_following` forever, and a
// member in reconciliation for such a request cycles every backoff as
// "may have reached Bluesky — not re-sent" and never gets the real
// retry it is owed.
//
// The manual path already draws this line (`mutation-outcome.ts`,
// `isAmbiguousFailure`). This is the same line, for the worker.

/**
 * Provider error codes that PROVE the request was refused before any
 * write. An action carrying one of these may be re-opened for a real
 * retry; an action carrying anything else stays in reconciliation.
 *
 * Closed set, mirrored in `reopen_bluesky_campaign_action`, which
 * refuses any code not in it — so a code added here without the
 * migration cannot re-open anything.
 */
export const DEFINITE_REJECTION_CODES: ReadonlySet<string> = new Set([
  "ExpiredToken",
  "InvalidToken",
  "AuthMissing",
  "AuthenticationRequired",
  "session_expired",
  "RateLimitExceeded",
  "rate_limited",
  "provider_rejected_before_write",
]);

/**
 * Did this failure prove the provider wrote nothing?
 *
 * Conservative in the direction that avoids duplicates: only shapes
 * where the PDS rejects at the door are rejections. A network error is
 * NOT — the request may have been received and the response lost. A
 * 5xx is NOT — the write may have committed before the failure. An
 * unparseable 2xx is NOT — it almost certainly landed.
 */
export function rejectedBeforeWrite(failure: {
  kind: string;
  status: number;
}): boolean {
  if (failure.kind === "auth") return true;
  if (failure.kind === "rate_limited") return true;
  if (failure.kind === "network") return false;
  if (failure.status >= 500) return false;
  if (failure.status >= 200 && failure.status < 300) return false;
  // A 4xx that is neither auth nor rate limiting describes the REQUEST
  // and was refused. (`not_found` and `ineligible` are terminal for the
  // member and never reach reconciliation anyway.)
  return failure.status >= 400 && failure.status < 500;
}

/**
 * Which stored provider error code means "re-open for a real retry"
 * when reconciliation finds the follow absent. Applied to actions that
 * were filed as reconciliation_required BEFORE this distinction existed
 * — production holds three such rows.
 */
export function isDefiniteRejectionCode(code: string | null | undefined): boolean {
  return Boolean(code) && DEFINITE_REJECTION_CODES.has(String(code));
}

/**
 * Reconciliation backoff: the slow lane.
 *
 * Ten minutes for the first twelve reads (two hours), then six hours.
 * Never terminal, never a tight loop, always visible. An ambiguity that
 * has not resolved in two hours is not going to resolve in the next ten
 * minutes either — but it might tomorrow, and the member must not be
 * forgotten while it waits.
 */
export const RECONCILIATION_FAST_BACKOFF_MS = 10 * 60_000;
export const RECONCILIATION_SLOW_BACKOFF_MS = 6 * 60 * 60_000;
export const RECONCILIATION_FAST_READS = 12;

export function reconciliationBackoffMs(reconcileCount: number): number {
  return reconcileCount >= RECONCILIATION_FAST_READS
    ? RECONCILIATION_SLOW_BACKOFF_MS
    : RECONCILIATION_FAST_BACKOFF_MS;
}
