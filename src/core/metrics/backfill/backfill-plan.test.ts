import { describe, expect, it } from "vitest";
import {
  MAX_BACKFILL_POSTS,
  buildBatches,
  describePlan,
  planBackfill,
  type BackfillCandidate,
} from "./backfill-plan";
import { batchCount, providerRate } from "./backfill-cost";
import {
  assessCost,
  evaluateBudget,
  evaluateSpend,
} from "../budget/x-read-budget";

const FRESH = { configuredRate: null, nowIso: "2026-08-19T12:00:00.000Z" };
const OPEN_BUDGET = evaluateBudget(0, 500);

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    workspaceId: "w1",
    publishHistoryId: "ph1",
    platform: "bluesky",
    externalPostId: "at://did/app.bsky.feed.post/1",
    permalink: "https://bsky.app/p/1",
    publishedAt: "2026-06-01T12:00:00.000Z",
    alreadyMeasured: false,
    ...over,
  };
}

const RANGE = { since: "2026-01-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" };

describe("batching is an API property and stays here", () => {
  it("batches to the provider's documented limit", () => {
    expect(providerRate("bluesky")?.batchSize).toBe(25);
    expect(batchCount(13, 25)).toBe(1); // one Bluesky getPosts call
    expect(batchCount(150, 100)).toBe(2);
    expect(batchCount(0, 25)).toBe(0);
  });
});

describe("cost now comes from the budget module", () => {
  it("prices the real production backfill", () => {
    const a = assessCost({ x: 15, bluesky: 13 }, FRESH);
    expect(a.estimatedUsd).toBeCloseTo(0.015, 6);
    expect(a.costKnown).toBe(true);
  });

  it("allows a free run without confirmation", () => {
    expect(
      evaluateSpend({ assessment: assessCost({ bluesky: 13 }, FRESH), budget: OPEN_BUDGET }),
    ).toEqual({ allowed: true, reason: "free" });
  });

  it("refuses a paid run with no confirmation", () => {
    const v = evaluateSpend({ assessment: assessCost({ x: 15 }, FRESH), budget: OPEN_BUDGET });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("confirmation_required");
  });

  it("allows it once confirmed", () => {
    expect(
      evaluateSpend({ assessment: assessCost({ x: 15 }, FRESH), budget: OPEN_BUDGET, confirmedMaxUsd: 1 }),
    ).toEqual({ allowed: true, reason: "confirmed" });
  });
});

describe("planBackfill bounds", () => {
  it("excludes posts outside the range and says why", () => {
    const plan = planBackfill({
      candidates: [
        candidate({ publishHistoryId: "in", publishedAt: "2026-06-01T00:00:00.000Z" }),
        candidate({ publishHistoryId: "old", publishedAt: "2025-01-01T00:00:00.000Z" }),
        candidate({ publishHistoryId: "future", publishedAt: "2027-01-01T00:00:00.000Z" }),
      ],
      bounds: RANGE,
    });
    expect(plan.selected.map((c) => c.publishHistoryId)).toEqual(["in"]);
    expect(plan.rejected.map((r) => r.reason).sort()).toEqual([
      "outside_date_range",
      "outside_date_range",
    ]);
  });

  it("skips already-measured posts by default and includes them on request", () => {
    const cands = [candidate({ alreadyMeasured: true })];
    expect(planBackfill({ candidates: cands, bounds: RANGE }).selected).toHaveLength(0);
    expect(
      planBackfill({
        candidates: cands,
        bounds: { ...RANGE, includeAlreadyMeasured: true },
      }).selected,
    ).toHaveLength(1);
  });

  it("never lets an unreadable post consume budget", () => {
    const plan = planBackfill({
      candidates: [candidate({ externalPostId: null, permalink: null })],
      bounds: RANGE,
    });
    expect(plan.selected).toHaveLength(0);
    expect(plan.rejected[0].reason).toBe("no_provider_identifier");
    expect(plan.cost.resources.totalResources).toBe(0);
  });

  it("caps at maxPosts and keeps the MOST RECENT posts", () => {
    const plan = planBackfill({
      candidates: [
        candidate({ publishHistoryId: "old", publishedAt: "2026-02-01T00:00:00.000Z" }),
        candidate({ publishHistoryId: "new", publishedAt: "2026-08-01T00:00:00.000Z" }),
        candidate({ publishHistoryId: "mid", publishedAt: "2026-05-01T00:00:00.000Z" }),
      ],
      bounds: { ...RANGE, maxPosts: 2 },
    });
    expect(plan.selected.map((c) => c.publishHistoryId)).toEqual(["new", "mid"]);
    expect(plan.rejected.find((r) => r.reason === "over_max_posts")?.candidate.publishHistoryId).toBe("old");
  });

  it("enforces the hard ceiling even when the caller asks for more", () => {
    const plan = planBackfill({
      candidates: [],
      bounds: { ...RANGE, maxPosts: 10_000 },
    });
    expect(plan.bounds.maxPosts).toBe(MAX_BACKFILL_POSTS);
  });

  it("restricts to requested platforms", () => {
    const plan = planBackfill({
      candidates: [
        candidate({ publishHistoryId: "b", platform: "bluesky" }),
        candidate({ publishHistoryId: "x", platform: "x" }),
      ],
      bounds: { ...RANGE, platforms: ["bluesky"] },
    });
    expect(plan.selected.map((c) => c.platform)).toEqual(["bluesky"]);
    expect(plan.rejected[0].reason).toBe("platform_excluded");
  });

  it("is deterministic — same input, same plan", () => {
    const cands = [
      candidate({ publishHistoryId: "a", publishedAt: "2026-06-01T00:00:00.000Z" }),
      candidate({ publishHistoryId: "b", publishedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const a = planBackfill({ candidates: cands, bounds: RANGE });
    const b = planBackfill({ candidates: [...cands].reverse(), bounds: RANGE });
    expect(a.selected.map((c) => c.publishHistoryId)).toEqual(
      b.selected.map((c) => c.publishHistoryId),
    );
  });

  it("is not executable while the spend gate is closed", () => {
    const plan = planBackfill({
      candidates: [candidate({ platform: "x" })],
      bounds: RANGE,
    });
    expect(plan.gate.allowed).toBe(false);
    expect(plan.executable).toBe(false);
    expect(describePlan(plan)).toContain("Plan blocked");
  });
});

describe("buildBatches", () => {
  it("packs 13 Bluesky posts into a single getPosts request", () => {
    const batches = buildBatches(
      Array.from({ length: 13 }, (_, i) => candidate({ publishHistoryId: `p${i}` })),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].candidates).toHaveLength(13);
  });

  it("splits at the provider limit and never mixes platforms in one batch", () => {
    const batches = buildBatches([
      ...Array.from({ length: 30 }, (_, i) => candidate({ publishHistoryId: `b${i}` })),
      ...Array.from({ length: 5 }, (_, i) => candidate({ publishHistoryId: `x${i}`, platform: "x" })),
    ]);
    expect(batches.filter((b) => b.platform === "bluesky")).toHaveLength(2); // 25 + 5
    expect(batches.filter((b) => b.platform === "x")).toHaveLength(1);
    for (const b of batches) {
      expect(new Set(b.candidates.map((c) => c.platform)).size).toBe(1);
    }
  });
});

describe("describePlan", () => {
  it("explains an empty plan by naming the exclusion reasons", () => {
    const plan = planBackfill({
      candidates: [candidate({ publishedAt: "2020-01-01T00:00:00.000Z" })],
      bounds: RANGE,
    });
    expect(describePlan(plan)).toContain("outside_date_range x1");
  });
});
