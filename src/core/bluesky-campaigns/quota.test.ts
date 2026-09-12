import { describe, expect, it } from "vitest";
import {
  computeEffectiveQuota,
  consumesQuota,
  DAILY_QUOTA_OPTIONS,
  estimateCompletionDate,
  IDENTITY_DAILY_FOLLOW_CEILING,
  isDailyQuota,
  SUCCESS_RATE_MIN_SAMPLE,
  type QuotaOutcome,
} from "./quota";

const base = {
  requested: 1000,
  identityFollowsToday: 0,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 5,
  attemptedToday: 0,
  succeededToday: 0,
  minSuccessRatePercent: 50,
  remainingEligible: 100_000,
  now: new Date("2026-09-11T12:00:00Z"),
};

describe("the selectable quotas", () => {
  it("offers every 100 from 100 to 1,000", () => {
    // The set used to skip 300, 500, 700 and 900, so an operator who
    // wanted 300 a day had to choose 200 or 400. The CEILING is
    // unchanged at 1,000 — only the gaps are gone.
    expect([...DAILY_QUOTA_OPTIONS]).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  });

  it("accepts 300 specifically", () => {
    // Named on its own because it is the value the gap was reported
    // for, and a set assertion can be satisfied while the validator
    // disagrees.
    expect(isDailyQuota(300)).toBe(true);
    expect(DAILY_QUOTA_OPTIONS).toContain(300);
  });

  it("accepts each one and rejects anything else", () => {
    for (const q of DAILY_QUOTA_OPTIONS) expect(isDailyQuota(q)).toBe(true);
    // Including values INSIDE the range that are not on the 100 step,
    // and the one just past the ceiling.
    for (const q of [
      0, 50, 99, 101, 150, 250, 350, 999, 1001, 1100, 2000, 5000, -100, NaN,
    ]) {
      expect(isDailyQuota(q), String(q)).toBe(false);
    }
  });

  it("does not raise the ceiling", () => {
    expect(Math.max(...DAILY_QUOTA_OPTIONS)).toBe(1000);
  });

  it("every option is achievable when nothing constrains it", () => {
    for (const requested of DAILY_QUOTA_OPTIONS) {
      const r = computeEffectiveQuota({ ...base, requested });
      expect(r.effective, `quota ${requested}`).toBe(requested);
      expect(r.reason).toBeNull();
      expect(r.halted).toBe(false);
    }
  });
});

describe("effective quota is never above requested", () => {
  it("cannot exceed the operator's choice however much headroom exists", () => {
    for (const requested of DAILY_QUOTA_OPTIONS) {
      const r = computeEffectiveQuota({
        ...base,
        requested,
        identityFollowsToday: 0,
        remainingEligible: 10_000_000,
      });
      expect(r.effective).toBeLessThanOrEqual(requested);
    }
  });
});

describe("effective quota can be lower than requested", () => {
  it("is reduced by the identity's remaining daily allowance", () => {
    const r = computeEffectiveQuota({
      ...base,
      requested: 1000,
      identityFollowsToday: IDENTITY_DAILY_FOLLOW_CEILING - 250,
    });
    expect(r.effective).toBe(250);
    expect(r.reason).toContain("250");
    expect(r.reason).toContain("shared across every campaign");
  });

  it("is reduced to what is actually left in the queue", () => {
    const r = computeEffectiveQuota({ ...base, requested: 1000, remainingEligible: 37 });
    expect(r.effective).toBe(37);
    expect(r.reason).toContain("37");
  });

  it("takes the MINIMUM of every constraint, not the first", () => {
    const r = computeEffectiveQuota({
      ...base,
      requested: 800,
      identityFollowsToday: IDENTITY_DAILY_FOLLOW_CEILING - 400,
      remainingEligible: 120,
    });
    expect(r.effective).toBe(120);
  });

  it("two campaigns sharing an identity cannot jointly exceed its ceiling", () => {
    // First campaign used 600 today.
    const second = computeEffectiveQuota({
      ...base,
      requested: 1000,
      identityFollowsToday: 600,
    });
    expect(second.effective).toBe(IDENTITY_DAILY_FOLLOW_CEILING - 600);
    expect(600 + second.effective).toBeLessThanOrEqual(IDENTITY_DAILY_FOLLOW_CEILING);
  });
});

describe("circuit breakers halt rather than shrink", () => {
  it("a live rate limit stops everything and names the reset", () => {
    const until = new Date("2026-09-11T12:30:00Z");
    const r = computeEffectiveQuota({ ...base, rateLimitedUntil: until });
    expect(r.effective).toBe(0);
    expect(r.halted).toBe(true);
    expect(r.reason).toContain(until.toISOString());
  });

  it("an expired rate limit no longer constrains", () => {
    const r = computeEffectiveQuota({
      ...base,
      rateLimitedUntil: new Date("2026-09-11T11:00:00Z"),
    });
    expect(r.effective).toBe(1000);
  });

  it("consecutive failures at the threshold halt", () => {
    const r = computeEffectiveQuota({
      ...base,
      consecutiveFailures: 5,
      maxConsecutiveFailures: 5,
    });
    expect(r.effective).toBe(0);
    expect(r.halted).toBe(true);
    expect(r.reason).toContain("consecutive failures");
  });

  it("a low success rate halts once the sample is meaningful", () => {
    const r = computeEffectiveQuota({
      ...base,
      attemptedToday: 40,
      succeededToday: 10,
      minSuccessRatePercent: 50,
    });
    expect(r.effective).toBe(0);
    expect(r.reason).toContain("25%");
  });

  it("does NOT halt on a small sample — one early failure is noise", () => {
    // 1 of 2 succeeded is a 50% rate, but two attempts prove nothing.
    const r = computeEffectiveQuota({
      ...base,
      attemptedToday: 2,
      succeededToday: 0,
      minSuccessRatePercent: 50,
    });
    expect(r.effective).toBe(1000);
    expect(r.halted).toBe(false);
    expect(SUCCESS_RATE_MIN_SAMPLE).toBeGreaterThan(2);
  });

  it("a healthy rate at a large sample does not halt", () => {
    const r = computeEffectiveQuota({
      ...base,
      attemptedToday: 500,
      succeededToday: 480,
      minSuccessRatePercent: 50,
    });
    expect(r.effective).toBe(1000);
  });
});

describe("which outcomes consume quota", () => {
  const consuming: QuotaOutcome[] = [
    "succeeded",
    "failed_structural",
    "retryable_exhausted",
  ];
  const neutral: QuotaOutcome[] = [
    "already_following",
    "protected",
    "skipped",
    "released",
    "rate_limited",
  ];

  it("an attempt that reached the provider consumes it", () => {
    for (const o of consuming) expect(consumesQuota(o), o).toBe(true);
  });

  it("already_following does NOT consume quota", () => {
    // The requirement is explicit: no record was created, so it must
    // not cost the operator a follow they never made.
    expect(consumesQuota("already_following")).toBe(false);
  });

  it("nothing that never reached the provider consumes it", () => {
    for (const o of neutral) expect(consumesQuota(o), o).toBe(false);
  });

  it("every outcome is classified — no silent default", () => {
    for (const o of [...consuming, ...neutral]) {
      expect(typeof consumesQuota(o)).toBe("boolean");
    }
  });
});

describe("estimated completion", () => {
  it("refuses to guess without an observed rate", () => {
    // A campaign that has never run has no evidence, and a confident
    // date with nothing behind it is worse than no date.
    expect(
      estimateCompletionDate({
        remainingEligible: 50_000,
        observedDailySuccesses: null,
        from: new Date("2026-09-11T00:00:00Z"),
      }),
    ).toBeNull();
    expect(
      estimateCompletionDate({
        remainingEligible: 50_000,
        observedDailySuccesses: 0,
        from: new Date("2026-09-11T00:00:00Z"),
      }),
    ).toBeNull();
  });

  it("returns null when there is nothing left", () => {
    expect(
      estimateCompletionDate({
        remainingEligible: 0,
        observedDailySuccesses: 500,
        from: new Date("2026-09-11T00:00:00Z"),
      }),
    ).toBeNull();
  });

  it("projects from SUCCESSES, not attempts", () => {
    const r = estimateCompletionDate({
      remainingEligible: 100_000,
      observedDailySuccesses: 800,
      from: new Date("2026-09-11T00:00:00Z"),
    })!;
    expect(r.daysRemaining).toBe(125);
    expect(r.date.toISOString().slice(0, 10)).toBe("2027-01-14");
  });
});
