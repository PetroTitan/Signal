/**
 * Provider outcome → member status, for unfollow campaigns.
 *
 * Pure, client-safe, no I/O. One place where the failure policy lives,
 * so "what does a 5xx do" has one answer rather than one per call site.
 *
 * WHAT CARRIES OVER FROM FOLLOW, UNCHANGED
 * ----------------------------------------
 * An outcome Signal could not read is not a failure and is never
 * retried blindly.
 *
 * WHY THAT RULE IS *MORE* IMPORTANT HERE, NOT LESS
 * ------------------------------------------------
 * It is tempting to argue the opposite. `createRecord` is not
 * idempotent, so a blind follow retry leaves two records — whereas
 * `deleteRecord` is documented as idempotent, so a blind delete retry
 * "just works".
 *
 * That argument is wrong, and the reason is time. Between the request
 * whose outcome was lost and the retry, the relationship can change.
 * The operator may re-follow by hand, minting a new record under a new
 * key; a second delete aimed at the current key would then remove a
 * follow the operator deliberately created. Idempotence protects the
 * REQUEST from being repeated. It does not protect the WORLD from
 * having moved on.
 *
 * So an ambiguous unfollow reconciles against relationship truth, and
 * `reconcile_only` is a mode in which no delete can be issued at all.
 */

export type UnfollowOutcomeKind =
  | "succeeded"
  /** Dry run: every step EXCEPT the provider call. */
  | "dry_run"
  /** The follow record was already absent. Neutral success, no quota. */
  | "already_not_following"
  /** Protected: excluded before anything was sent. */
  | "protected"
  /** Another unresolved intention exists for this identity + subject. */
  | "conflict"
  /** No safe delete target could be resolved. */
  | "no_record_target"
  | "retryable_transport_failure"
  | "rate_limited"
  | "authentication_expired"
  | "structural_provider_failure"
  | "cancelled";

export type NextAction =
  | { kind: "continue" }
  | { kind: "stop_run"; reason: string; resumeAfter?: Date | null }
  | { kind: "stop_campaign"; campaignStatus: UnfollowHaltStatus; reason: string };

export type UnfollowHaltStatus =
  | "reauthorization_required"
  | "rate_limited"
  | "failed";

export type UnfollowMemberStatus =
  | "succeeded"
  | "already_not_following"
  | "protected"
  | "skipped"
  | "retryable"
  | "failed_structural"
  | "cancelled";

export interface UnfollowOutcomeDecision {
  kind: UnfollowOutcomeKind;
  memberStatus: UnfollowMemberStatus;
  consumesQuota: boolean;
  countsAsSuccess: boolean;
  countsAsFailure: boolean;
  next: NextAction;
  retryable: boolean;
}

/** Attempts before a retryable member becomes terminal. */
export const MAX_MEMBER_ATTEMPTS = 4;

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Backoff before the next attempt.
 *
 * The jitter is not traffic disguising. It exists so twenty members
 * that failed in one chunk do not all retry in the same millisecond and
 * recreate the burst that failed. It applies to retry timing only,
 * never to the spacing between ordinary requests, which stays the fixed
 * courtesy interval the manual path uses.
 */
export function backoffDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const exponential =
    BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1));
  const capped = Math.min(exponential, BACKOFF_MAX_MS);
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(1_000, Math.round(capped + jitter));
}

export interface ClassifyInput {
  kind: UnfollowOutcomeKind;
  attemptCount: number;
  resumeAfter?: Date | null;
}

export function classifyUnfollowOutcome(
  input: ClassifyInput,
): UnfollowOutcomeDecision {
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

    case "already_not_following":
      // THE NEUTRAL SUCCESS. The operator's intent — "I should not be
      // following this person" — holds. No record was deleted, so no
      // unit of the day is spent: charging for a discovery would make a
      // campaign over a mostly-stale list cost a full day's quota and
      // achieve nothing.
      return {
        kind,
        memberStatus: "already_not_following",
        consumesQuota: false,
        countsAsSuccess: true,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "dry_run":
      // Recorded as `skipped`, never as `succeeded`, precisely so a dry
      // run cannot be mistaken for real progress by anything — a
      // counter, a chart, or an operator reading the page.
      return {
        kind,
        memberStatus: "skipped",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "protected":
      return {
        kind,
        memberStatus: "protected",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "conflict":
      // FAIL CLOSED. Another unresolved intention exists for this
      // identity and subject — an active follow campaign, or a manual
      // action. Nothing is sent.
      //
      // Terminal rather than retryable, and deliberately so: a conflict
      // is a configuration the operator has to see and decide about,
      // and retrying it four times would bury it under a backoff and
      // then report a structural failure that describes the wrong
      // problem. It consumes no quota because nothing reached the
      // provider — which is structurally guaranteed, not merely
      // declared: this branch never reaches the consume call.
      return {
        kind,
        memberStatus: "failed_structural",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "no_record_target":
      // The exact record could not be identified, and Signal does not
      // guess one. Terminal for this member, and it consumes nothing:
      // no request was made.
      return {
        kind,
        memberStatus: "failed_structural",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: { kind: "continue" },
        retryable: false,
      };

    case "rate_limited":
      // STOP. Not slower, not from a different address, not from
      // somewhere else — stop, and resume no earlier than the reset the
      // provider itself reported.
      //
      // `stop_run`, NOT `stop_campaign`, and the distinction is
      // load-bearing rather than stylistic. The dispatcher lists
      // campaigns to work on; a campaign moved to a terminal-looking
      // status by an automatic, temporary condition would drop out of
      // that listing and never be reconsidered. A 429 is the most
      // ordinary thing that can happen to a bulk job, so the state it
      // produces has to be one the scheduler can come back to.
      //
      // The member itself was NOT attempted: the request was refused
      // before it reached the record.
      return {
        kind,
        memberStatus: "retryable",
        consumesQuota: false,
        countsAsSuccess: false,
        countsAsFailure: false,
        next: {
          kind: "stop_run",
          reason:
            "Bluesky rate-limited this account. Unfollowing stopped and will resume no earlier than the reset time Bluesky reported.",
          resumeAfter: input.resumeAfter ?? null,
        },
        retryable: true,
      };

    case "authentication_expired":
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
            "Bluesky no longer accepts this account's session. Reconnect it to continue.",
        },
        retryable: true,
      };

    case "retryable_transport_failure": {
      // Bounded. A member that has used its attempts becomes terminal
      // and DOES consume quota — requests were genuinely made.
      const exhausted = attemptCount >= MAX_MEMBER_ATTEMPTS;
      return {
        kind,
        memberStatus: exhausted ? "failed_structural" : "retryable",
        consumesQuota: exhausted,
        countsAsSuccess: false,
        countsAsFailure: exhausted,
        next: { kind: "continue" },
        retryable: !exhausted,
      };
    }

    case "structural_provider_failure":
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
 * Map a provider failure onto an outcome kind.
 *
 * Note the default: anything unrecognised is a RETRYABLE transport
 * failure, not a success and not a structural failure. An unknown
 * response means we do not know what happened to a public record, and
 * the only honest handling of "we do not know" is to stop treating it
 * as an outcome.
 */
export function outcomeFromGraphFailure(failure: {
  kind: string;
  status: number;
}): UnfollowOutcomeKind {
  switch (failure.kind) {
    case "rate_limited":
      return "rate_limited";
    case "auth":
      return "authentication_expired";
    case "network":
      return "retryable_transport_failure";
    default:
      // A 4xx that is not auth or rate limiting describes the REQUEST:
      // a malformed rkey, a collection that does not exist. Retrying
      // the same request cannot change that.
      if (failure.status >= 400 && failure.status < 500) {
        return "structural_provider_failure";
      }
      return "retryable_transport_failure";
  }
}
