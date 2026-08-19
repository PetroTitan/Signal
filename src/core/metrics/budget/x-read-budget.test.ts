import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_X_READ_BUDGET,
  DOCUMENTED_X_OWNED_READ_USD,
  DOCUMENTED_X_RATE_VERIFIED_AT,
  PRICE_FRESHNESS_DAYS,
  assessCost,
  describeResourcePlan,
  evaluateBudget,
  evaluateSpend,
  planResources,
  resolveBudgets,
  resolveXReadPrice,
} from "./x-read-budget";

const FRESH_NOW = "2026-08-19T12:00:00.000Z";
const STALE_NOW = "2027-06-01T00:00:00.000Z";

describe("price resolution", () => {
  it("prefers an operator-configured rate", () => {
    const p = resolveXReadPrice({ configuredRate: "0.0025", nowIso: FRESH_NOW });
    expect(p.usdPerResource).toBe(0.0025);
    expect(p.source).toBe("configured");
  });

  it("falls back to the documented rate while it is fresh", () => {
    const p = resolveXReadPrice({ configuredRate: null, nowIso: FRESH_NOW });
    expect(p.usdPerResource).toBe(DOCUMENTED_X_OWNED_READ_USD);
    expect(p.source).toBe("documented");
    expect(p.verifiedAt).toBe(DOCUMENTED_X_RATE_VERIFIED_AT);
    expect(p.explanation).toContain("docs.x.com");
  });

  it("treats a documented rate past its freshness horizon as UNKNOWN, not as truth", () => {
    // A provider price is not code. A stale constant is worse than none
    // because it looks authoritative.
    const p = resolveXReadPrice({ configuredRate: null, nowIso: STALE_NOW });
    expect(p.usdPerResource).toBeNull();
    expect(p.source).toBe("unknown");
    expect(p.stale).toBe(true);
    expect(p.explanation).toContain(`${PRICE_FRESHNESS_DAYS}-day freshness horizon`);
  });

  it("a malformed configured rate is unknown, never a licence to guess", () => {
    for (const bad of ["free", "-1", "abc"]) {
      const p = resolveXReadPrice({ configuredRate: bad, nowIso: FRESH_NOW });
      expect(p.usdPerResource, bad).toBeNull();
      expect(p.source).toBe("unknown");
    }
  });

  it("accepts a configured rate of zero — that is a real statement", () => {
    // An operator on a free allowance may legitimately configure 0.
    const p = resolveXReadPrice({ configuredRate: "0", nowIso: FRESH_NOW });
    expect(p.usdPerResource).toBe(0);
    expect(p.source).toBe("configured");
  });
});

describe("resource counts are always knowable", () => {
  it("separates billable from free reads", () => {
    const plan = planResources({ x: 15, bluesky: 13, reddit: 2 });
    expect(plan.xResources).toBe(15);
    expect(plan.freeResources).toBe(15);
    expect(plan.totalResources).toBe(30);
  });

  it("reports counts even when the price is unknown", () => {
    const a = assessCost({ x: 15 }, { configuredRate: null, nowIso: STALE_NOW });
    expect(a.costKnown).toBe(false);
    expect(a.estimatedUsd).toBeNull();
    expect(a.resources.xResources).toBe(15);
    expect(describeResourcePlan(a)).toContain("15 billable resource(s)");
    expect(describeResourcePlan(a)).toContain("cost unknown");
  });
});

describe("THE HARD INVARIANT: unknown price is not zero cost", () => {
  const unknown = assessCost({ x: 15 }, { configuredRate: null, nowIso: STALE_NOW });

  it("never reports $0 for an unpriced billable plan", () => {
    expect(unknown.estimatedUsd).not.toBe(0);
    expect(unknown.estimatedUsd).toBeNull();
    expect(unknown.summary).toContain("UNKNOWN");
  });

  it("refuses to run automatically", () => {
    const verdict = evaluateSpend({
      assessment: unknown,
      budget: evaluateBudget(0, DEFAULT_DAILY_X_READ_BUDGET),
      confirmedMaxUsd: 1000,
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("cost_unknown");
      expect(verdict.message).toContain("confirmedMaxResources >= 15");
    }
  });

  it("a dollar confirmation cannot authorise an unpriced plan", () => {
    // You cannot cap in dollars what you cannot price.
    const verdict = evaluateSpend({
      assessment: unknown,
      budget: evaluateBudget(0, DEFAULT_DAILY_X_READ_BUDGET),
      confirmedMaxUsd: 999999,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("BUT an explicit resource-count authorisation does", () => {
    const verdict = evaluateSpend({
      assessment: unknown,
      budget: evaluateBudget(0, DEFAULT_DAILY_X_READ_BUDGET),
      confirmedMaxResources: 15,
    });
    expect(verdict).toEqual({ allowed: true, reason: "confirmed" });
  });

  it("and an insufficient resource authorisation does not", () => {
    const verdict = evaluateSpend({
      assessment: unknown,
      budget: evaluateBudget(0, DEFAULT_DAILY_X_READ_BUDGET),
      confirmedMaxResources: 5,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("the only path to a zero estimate is having nothing billable", () => {
    const free = assessCost({ bluesky: 13 }, { configuredRate: null, nowIso: STALE_NOW });
    expect(free.estimatedUsd).toBe(0);
    expect(free.entirelyFree).toBe(true);
    expect(evaluateSpend({ assessment: free, budget: evaluateBudget(0, 500) })).toEqual({
      allowed: true,
      reason: "free",
    });
  });
});

describe("budgets", () => {
  it("uses the documented defaults when unset", () => {
    const b = resolveBudgets({});
    expect(b.dailyXReads).toBe(DEFAULT_DAILY_X_READ_BUDGET);
  });

  it("respects an operator override", () => {
    expect(resolveBudgets({ dailyXReads: "25" }).dailyXReads).toBe(25);
  });

  it("ignores a nonsense override rather than disabling the budget", () => {
    expect(resolveBudgets({ dailyXReads: "0" }).dailyXReads).toBe(DEFAULT_DAILY_X_READ_BUDGET);
    expect(resolveBudgets({ dailyXReads: "-5" }).dailyXReads).toBe(DEFAULT_DAILY_X_READ_BUDGET);
  });

  it("blocks a plan larger than the remaining budget", () => {
    const a = assessCost({ x: 100 }, { configuredRate: "0.001", nowIso: FRESH_NOW });
    const v = evaluateSpend({
      assessment: a,
      budget: evaluateBudget(480, 500),
      confirmedMaxUsd: 100,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe("over_budget");
      expect(v.message).toContain("only 20 remain");
    }
  });

  it("blocks entirely when the budget is spent", () => {
    const a = assessCost({ x: 1 }, { configuredRate: "0.001", nowIso: FRESH_NOW });
    const v = evaluateSpend({ assessment: a, budget: evaluateBudget(500, 500), confirmedMaxUsd: 1 });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("budget_exhausted");
  });

  it("checks the resource budget BEFORE the price, so it applies either way", () => {
    const unpriced = assessCost({ x: 100 }, { configuredRate: null, nowIso: STALE_NOW });
    const v = evaluateSpend({
      assessment: unpriced,
      budget: evaluateBudget(500, 500),
      confirmedMaxResources: 100,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("budget_exhausted");
  });

  it("a free plan is never blocked by the X budget", () => {
    const free = assessCost({ bluesky: 1000 }, { configuredRate: null, nowIso: FRESH_NOW });
    expect(evaluateSpend({ assessment: free, budget: evaluateBudget(500, 500) }).allowed).toBe(true);
  });
});

describe("the real production backfill", () => {
  it("prices 15 X posts and 13 Bluesky posts", () => {
    const a = assessCost({ x: 15, bluesky: 13 }, { configuredRate: null, nowIso: FRESH_NOW });
    expect(a.resources.xResources).toBe(15);
    expect(a.estimatedUsd).toBeCloseTo(0.015, 6);
    expect(a.costKnown).toBe(true);
  });

  it("still requires explicit confirmation despite being trivially cheap", () => {
    const a = assessCost({ x: 15 }, { configuredRate: null, nowIso: FRESH_NOW });
    const v = evaluateSpend({ assessment: a, budget: evaluateBudget(0, 500) });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("confirmation_required");
  });
});
