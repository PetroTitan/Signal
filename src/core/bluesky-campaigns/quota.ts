/**
 * Daily quota semantics.
 *
 * Pure, client-safe. The UI and the worker share these definitions so
 * what an operator is shown and what the server computes cannot drift.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * `requestedDailyQuota` is what the operator chose. It is never an
 * attempt budget. `effectiveDailyQuota` is what Signal is currently
 * allowed to attempt, and it is computed by the SERVER from the
 * identity's remaining provider allowance, the circuit breakers and any
 * rate-limit state. The two are reported separately, always, because
 * "1000/day" as a single number would be a promise Signal cannot keep.
 *
 * WHAT BLUESKY ACTUALLY ALLOWS
 * ----------------------------
 * From the published rate limits (docs.bsky.app, "Rate Limits"):
 *
 *   - 5,000 points/hour and 35,000 points/day, per ACCOUNT (DID).
 *   - A CREATE costs 3 points ⇒ 1,666 records/hour, 11,666 records/day.
 *   - Overall API requests: 3,000 per 5 minutes, limited BY IP — which
 *     on a shared serverless egress is the tighter constraint.
 *
 * So the largest quota an operator can pick, 1,000/day, is about 8.6%
 * of the documented daily write budget. Comfortable — and still not a
 * guarantee, because the same document notes that "moderation systems
 * and other application-specific limits may apply" and that bulk
 * interaction is against the Community Guidelines. Nothing in this file
 * tries to work around any of that.
 */

/** The only quotas an operator may select. */
export const DAILY_QUOTA_OPTIONS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
] as const;
export type DailyQuota = (typeof DAILY_QUOTA_OPTIONS)[number];

export function isDailyQuota(value: unknown): value is DailyQuota {
  return (DAILY_QUOTA_OPTIONS as readonly number[]).includes(Number(value));
}

/**
 * Signal's own per-identity ceiling for campaign follows in a day.
 *
 * Deliberately far below the provider's documented 11,666: campaigns
 * are unattended, and an unattended system should sit well inside a
 * limit rather than near it. It also leaves the identity's budget free
 * for the manual workflows and for publishing, which share the account.
 */
export const IDENTITY_DAILY_FOLLOW_CEILING = 1000;

/**
 * The provider's documented daily record-creation budget, for display.
 * Not used as a limit — `IDENTITY_DAILY_FOLLOW_CEILING` binds first.
 */
export const PROVIDER_DOCUMENTED_DAILY_CREATES = 11_666;

/** Attempts that count against the day's quota. */
export type QuotaConsumingOutcome =
  | "succeeded"
  | "failed_structural"
  | "retryable_exhausted";

/** Attempts that do NOT count against the day's quota. */
export type QuotaNeutralOutcome =
  | "already_following"
  | "protected"
  | "skipped"
  | "released"
  | "rate_limited";

export type QuotaOutcome = QuotaConsumingOutcome | QuotaNeutralOutcome;

/**
 * Does this outcome consume a unit of the day's quota?
 *
 * The rule: an outcome consumes quota when Signal SENT something to the
 * provider on that member's behalf. `already_following` is the case the
 * requirement calls out explicitly — no record was created, so it must
 * not cost the operator a follow they never made. `protected` and
 * `skipped` never reached the provider at all, and a released lease was
 * never attempted.
 *
 * Note what this deliberately does NOT do: it does not refill the quota
 * by pulling in extra candidates to replace a failure. A day that hits
 * three structural failures attempts 997 more, not 1,000 more.
 */
export function consumesQuota(outcome: QuotaOutcome): boolean {
  switch (outcome) {
    case "succeeded":
    case "failed_structural":
    case "retryable_exhausted":
      return true;
    case "already_following":
    case "protected":
    case "skipped":
    case "released":
    case "rate_limited":
      return false;
  }
}

export interface EffectiveQuotaInput {
  requested: number;
  /** Follows this identity has already created today, across campaigns. */
  identityFollowsToday: number;
  /** Signal's per-identity ceiling. Injected so tests can vary it. */
  identityCeiling?: number;
  /** Consecutive failures observed in the current run. */
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** Attempts and successes so far in the current run. */
  /**
   * Attempts whose outcome is KNOWN.
   *
   * Not `attempted_count`. Quota is consumed at provider intent, so
   * `attempted_count` rises the instant a worker decides to follow
   * someone and before anything has come back — using it here made the
   * success rate read 0% mid-chunk and tripped the breaker on a
   * campaign that was working perfectly.
   *
   * The breaker is asking "are our follows failing?", and only a
   * resolved attempt can answer.
   */
  attemptedToday: number;
  succeededToday: number;
  minSuccessRatePercent: number;
  /** Set while a provider 429 is still in effect. */
  rateLimitedUntil?: Date | null;
  now?: Date;
  /** Members left that could still be attempted. */
  remainingEligible: number;
}

export interface EffectiveQuota {
  effective: number;
  /** Operator-facing explanation, or null when nothing reduced it. */
  reason: string | null;
  /** True when the reduction is a stop rather than a smaller number. */
  halted: boolean;
}

/**
 * The minimum number of attempts before a success RATE means anything.
 *
 * Without a floor, one failure in the first two attempts is a 50%
 * success rate and would trip a 50% threshold immediately — pausing a
 * healthy campaign on noise.
 */
export const SUCCESS_RATE_MIN_SAMPLE = 20;

/**
 * Compute what Signal may attempt now.
 *
 * Always the MINIMUM of every constraint, and never above `requested` —
 * the database enforces that too, because a bug that widened it would
 * have Signal attempting more than the operator approved.
 */
export function computeEffectiveQuota(input: EffectiveQuotaInput): EffectiveQuota {
  const now = input.now ?? new Date();
  const ceiling = input.identityCeiling ?? IDENTITY_DAILY_FOLLOW_CEILING;

  // A live rate limit is a stop, not a smaller number.
  if (input.rateLimitedUntil && input.rateLimitedUntil.getTime() > now.getTime()) {
    return {
      effective: 0,
      halted: true,
      reason: `Bluesky rate-limited this account. Nothing will be attempted until ${input.rateLimitedUntil.toISOString()}, which is the reset time Bluesky reported.`,
    };
  }

  if (input.consecutiveFailures >= input.maxConsecutiveFailures) {
    return {
      effective: 0,
      halted: true,
      reason: `Paused after ${input.consecutiveFailures} consecutive failures. Something is wrong that retrying will not fix.`,
    };
  }

  // Success rate, once there is enough of a sample to mean anything.
  if (input.attemptedToday >= SUCCESS_RATE_MIN_SAMPLE) {
    const rate = Math.floor((input.succeededToday / input.attemptedToday) * 100);
    if (rate < input.minSuccessRatePercent) {
      return {
        effective: 0,
        halted: true,
        reason: `Paused: ${rate}% of today's ${input.attemptedToday} attempts succeeded, below the ${input.minSuccessRatePercent}% threshold for this campaign.`,
      };
    }
  }

  const identityRemaining = Math.max(0, ceiling - input.identityFollowsToday);
  const candidates: { value: number; reason: string | null }[] = [
    { value: input.requested, reason: null },
    {
      value: identityRemaining,
      reason: `This Bluesky account has ${identityRemaining} follow(s) left of Signal's ${ceiling}/day ceiling, shared across every campaign using it.`,
    },
    {
      value: input.remainingEligible,
      reason: `Only ${input.remainingEligible} profile(s) remain in the queue.`,
    },
  ];

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.value < best.value) best = candidate;
  }
  const effective = Math.max(0, Math.min(best.value, input.requested));

  return {
    effective,
    halted: effective === 0 && input.remainingEligible > 0,
    reason: effective < input.requested ? best.reason : null,
  };
}

/**
 * Estimated completion date.
 *
 * Returns null rather than guessing when there is no evidence — a
 * campaign that has never run has no observed rate, and inventing one
 * would put a confident date in front of an operator that nothing
 * supports.
 */
export function estimateCompletionDate(input: {
  remainingEligible: number;
  /** Follows actually SUCCEEDING per day, observed. Not attempted. */
  observedDailySuccesses: number | null;
  from: Date;
}): { date: Date; daysRemaining: number } | null {
  if (input.remainingEligible <= 0) return null;
  if (!input.observedDailySuccesses || input.observedDailySuccesses <= 0) return null;
  const days = Math.ceil(input.remainingEligible / input.observedDailySuccesses);
  const date = new Date(input.from.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return { date, daysRemaining: days };
}
