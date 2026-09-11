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
      // Includes anything unrecognised. Deliberately terminal: an
      // unknown error retried indefinitely is how a bug becomes a
      // sustained burst of requests against someone else's service.
      return {
        kind,
        memberStatus: "failed_structural",
        consumesQuota: true,
        countsAsSuccess: false,
        countsAsFailure: true,
        next: {
          kind: "stop_campaign",
          campaignStatus: "failed",
          reason:
            "Bluesky returned a failure Signal does not recognise as temporary. The campaign is stopped rather than retried.",
        },
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
