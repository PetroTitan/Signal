/**
 * Daily quota semantics for unfollow campaigns.
 *
 * Pure and client-safe, so the confirmation screen and the worker share
 * one definition of "how many" and cannot drift.
 *
 * WHAT BLUESKY ACTUALLY ALLOWS — READ 2026-09-14
 * ----------------------------------------------
 * From https://docs.bsky.app/docs/rate-limits, fetched for this work
 * rather than carried over from the follow subsystem:
 *
 *   • 5,000 points/hour and 35,000 points/day, per ACCOUNT (DID)
 *   • CREATE 3 points · UPDATE 2 points · **DELETE 1 point**
 *   • Overall API requests: 3,000 per 5 minutes, limited BY IP
 *   • createSession: 30 per 5 min, 300 per day, per account
 *
 * A DELETE therefore costs ONE THIRD of a CREATE, and the provider
 * would permit **35,000 unfollows a day** on points alone. That is the
 * single most important thing this file knows, and it is the reason the
 * ceiling below is NOT derived from points: sizing an unattended bulk
 * unfollow from a 35,000/day budget would be sizing it from the wrong
 * number entirely.
 *
 * The same page says, verbatim:
 *
 *   "moderation systems and other application-specific limits may
 *    apply… bulk or spammy interactions are against the Community
 *    Guidelines."
 *
 * That is the binding constraint, it is a judgement rather than an
 * arithmetic, and nothing in this file tries to work around it.
 *
 * THE CEILING MODEL — ONE COMBINED BUDGET
 * ---------------------------------------
 * The provider's budget is a single pool per DID. Two independent
 * count-based ceilings would model something that does not exist, so
 * Follow and Unfollow SHARE one:
 *
 *   at most IDENTITY_DAILY_MUTATION_CEILING provider mutations per
 *   identity per day, across every campaign of either kind.
 *
 * It is enforced in the database, not here. `bluesky_identity_daily_
 * usage.attempts_made` is incremented by `consume_bluesky_member_quota`
 * for BOTH kinds, and `reserve_bluesky_campaign_quota` bounds new
 * reservations by it — so a day spent following genuinely leaves less
 * room for unfollowing, and the coupling cannot be forgotten by a
 * caller because no caller performs it.
 *
 * Worst case in provider terms: 1,000 CREATEs = 3,000 points, which is
 * 8.6% of the documented daily budget. 1,000 DELETEs is 1,000 points,
 * or 2.9%. The mix cannot exceed the former.
 */

/**
 * Point cost per repository operation, as the provider counts them.
 * Displayed to the operator; never used as a limit, because the
 * mutation ceiling below always binds first.
 */
export const PROVIDER_POINTS = { create: 3, update: 2, delete: 1 } as const;

export const PROVIDER_DAILY_POINT_BUDGET = 35_000;
export const PROVIDER_HOURLY_POINT_BUDGET = 5_000;

/**
 * Signal's own combined ceiling: provider mutations per identity per
 * day, shared by Follow and Unfollow.
 *
 * Deliberately equal to the follow subsystem's existing per-identity
 * ceiling, so adopting the shared model cannot RAISE what any identity
 * was already allowed to do. It can only lower it, and only when both
 * kinds are actually running.
 */
export const IDENTITY_DAILY_MUTATION_CEILING = 1_000;

/**
 * The quotas an operator may select.
 *
 * The same ten steps the follow flow offers. Offering an unfollow
 * campaign a larger number than a follow campaign would be saying
 * Signal considers bulk unfollowing safer than bulk following, and
 * nothing in the provider's documentation supports that.
 */
export const UNFOLLOW_DAILY_QUOTA_OPTIONS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
] as const;
export type UnfollowDailyQuota = (typeof UNFOLLOW_DAILY_QUOTA_OPTIONS)[number];

export function isUnfollowDailyQuota(v: unknown): v is UnfollowDailyQuota {
  return (UNFOLLOW_DAILY_QUOTA_OPTIONS as readonly number[]).includes(Number(v));
}

/**
 * Outcomes that consume a unit of the day's quota.
 *
 * The rule is the same one the follow subsystem uses, and it is about
 * what was SENT, not what was achieved: a unit is spent when Signal
 * issued a request on that member's behalf.
 *
 * `already_not_following` is the case the brief calls out. The follow
 * record was already absent when the run reached the member, so no
 * DELETE was issued, the operator's intent is satisfied, and charging
 * for it would shrink the day to pay for a discovery.
 */
export type UnfollowQuotaOutcome =
  | "succeeded"
  | "failed_structural"
  | "retryable_exhausted"
  | "already_not_following"
  | "protected"
  | "conflict"
  | "skipped"
  | "dry_run"
  | "released"
  | "rate_limited";

export function consumesQuota(outcome: UnfollowQuotaOutcome): boolean {
  switch (outcome) {
    case "succeeded":
    case "failed_structural":
    case "retryable_exhausted":
      return true;
    case "already_not_following":
    case "protected":
    case "conflict":
    case "skipped":
    case "dry_run":
    case "released":
    case "rate_limited":
      return false;
  }
}

/** Why the effective quota is below what was requested. */
export type QuotaReduction =
  | "identity_ceiling"
  | "rate_limited"
  | "circuit_breaker"
  | "queue_smaller"
  | null;

export interface EffectiveQuotaInput {
  /** What the operator chose. NEVER an attempt budget. */
  requested: number;
  /**
   * Provider mutations this identity has already made today, of EITHER
   * kind. The shared counter is the point of the shared ceiling.
   */
  identityMutationsToday: number;
  identityCeiling?: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** Attempts whose outcome is KNOWN. Not attempts made. */
  resolvedToday: number;
  succeededToday: number;
  minSuccessRatePercent: number;
  rateLimitedUntil: Date | null;
  remainingEligible: number;
  /** False for the run's stored budget — units, not people. See the follow quota module. */
  boundByQueue?: boolean;
  now: Date;
}

export interface EffectiveQuota {
  requested: number;
  effective: number;
  reason: string | null;
  reduction: QuotaReduction;
  /** True when a breaker stopped it, rather than a limit bounding it. */
  halted: boolean;
}

/**
 * The effective quota: always the MINIMUM safe value, with the reason
 * kept separately so the operator sees both numbers and why they differ.
 *
 * Note what this never does: it does not raise the requested quota, and
 * it does not refill the day by substituting extra profiles for ones
 * that failed. A day that hits three structural failures attempts the
 * remainder, not three more.
 */
export function computeEffectiveUnfollowQuota(
  input: EffectiveQuotaInput,
): EffectiveQuota {
  const requested = Math.max(0, Math.floor(input.requested));
  const ceiling = input.identityCeiling ?? IDENTITY_DAILY_MUTATION_CEILING;

  if (input.rateLimitedUntil && input.rateLimitedUntil > input.now) {
    return {
      requested,
      effective: 0,
      reason: `Bluesky rate-limited this account. Nothing will be sent before ${input.rateLimitedUntil.toISOString()}.`,
      reduction: "rate_limited",
      halted: true,
    };
  }

  if (input.consecutiveFailures >= input.maxConsecutiveFailures) {
    return {
      requested,
      effective: 0,
      reason: `Stopped after ${input.consecutiveFailures} failures in a row.`,
      reduction: "circuit_breaker",
      halted: true,
    };
  }

  // The success-rate breaker needs a sample before it means anything. A
  // single failed first attempt is 0%, and tripping on that would stop
  // every campaign that begins with one bad profile.
  const MIN_SAMPLE = 10;
  if (input.resolvedToday >= MIN_SAMPLE) {
    const rate = Math.round((input.succeededToday / input.resolvedToday) * 100);
    if (rate < input.minSuccessRatePercent) {
      return {
        requested,
        effective: 0,
        reason: `Stopped: ${rate}% of today's attempts succeeded, below the ${input.minSuccessRatePercent}% you set.`,
        reduction: "circuit_breaker",
        halted: true,
      };
    }
  }

  const identityRemaining = Math.max(
    0,
    ceiling - Math.max(0, input.identityMutationsToday),
  );
  const eligible =
    input.boundByQueue === false
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, input.remainingEligible);

  const effective = Math.min(requested, identityRemaining, eligible);

  let reduction: QuotaReduction = null;
  let reason: string | null = null;
  if (effective < requested) {
    if (identityRemaining <= eligible && identityRemaining < requested) {
      reduction = "identity_ceiling";
      reason =
        identityRemaining === 0
          ? `This Bluesky account has used its ${ceiling.toLocaleString()} actions for today. It resumes tomorrow.`
          : `Reduced to ${identityRemaining.toLocaleString()}: this Bluesky account has ${identityRemaining.toLocaleString()} of its ${ceiling.toLocaleString()} daily actions left, shared with any follow campaign.`;
    } else {
      reduction = "queue_smaller";
      reason = `Only ${eligible.toLocaleString()} profiles are left in the list.`;
    }
  }

  return { requested, effective, reason, reduction, halted: false };
}

/**
 * Days remaining, as an ESTIMATE and labelled as one everywhere it is
 * shown.
 *
 * It cannot be a promise: the effective quota is recomputed every day
 * from state that does not exist yet — what a follow campaign spends,
 * whether the provider rate-limits, whether the session survives.
 */
export function estimateDays(
  remainingEligible: number,
  effectiveDailyQuota: number,
): number | null {
  if (effectiveDailyQuota <= 0) return null;
  return Math.ceil(remainingEligible / effectiveDailyQuota);
}
