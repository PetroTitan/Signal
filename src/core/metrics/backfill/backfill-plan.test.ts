import { describe, expect, it } from "vitest";
import {
  MAX_BACKFILL_POSTS,
  buildBatches,
  describePlan,
  planBackfill,
  type BackfillCandidate,
} from "./backfill-plan";
import {
  batchCount,
  estimateBackfillCost,
  evaluateCostGate,
  providerRate,
} from "./backfill-cost";

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

describe("cost model", () => {
  it("prices X owned reads at $0.001 and Bluesky at zero", () => {
    expect(providerRate("x")?.usdPerResource).toBe(0.001);
    expect(providerRate("bluesky")?.usdPerResource).toBe(0);
  });

  it("estimates the real production backfill at well under a cent", () => {
    // 15 X posts + 13 Bluesky posts — the actual publication history.
    const est = estimateBackfillCost({ x: 15, bluesky: 13 });
    expect(est.totalEstimatedUsd).toBeCloseTo(0.015, 6);
    expect(est.fullyPriced).toBe(true);
    expect(est.requiresPaidRun).toBe(true);
  });

  it("batches to the provider's documented limit", () => {
    expect(batchCount(13, 25)).toBe(1); // one Bluesky getPosts call
    expect(batchCount(150, 100)).toBe(2);
    expect(batchCount(0, 25)).toBe(0);
  });

  it("does NOT apply X's 24h billing dedup — the estimate is an upper bound", () => {
    // The docs describe dedup as a billing behaviour and say nothing about
    // value freshness. Estimating the discount would be assuming in our
    // own favour on an unverified premise.
    const once = estimateBackfillCost({ x: 10 });
    expect(once.totalEstimatedUsd).toBeCloseTo(0.01, 6);
  });
});

describe("cost gate", () => {
  it("allows a free run without any confirmation", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ bluesky: 13 }), null);
    expect(gate).toEqual({ allowed: true, reason: "free" });
  });

  it("refuses a paid run with no confirmation, and says what it would cost", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ x: 15 }), null);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toBe("confirmation_required");
      expect(gate.message).toContain("0.0150");
      expect(gate.message).toContain("console.x.com");
    }
  });

  it("refuses when the confirmed ceiling is below the estimate", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ x: 100 }), 0.01);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reason).toBe("confirmation_too_low");
  });

  it("allows a paid run once the operator confirms a sufficient ceiling", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ x: 15 }), 1);
    expect(gate).toEqual({ allowed: true, reason: "confirmed" });
  });

  it("blocks entirely when a platform has no documented rate", () => {
    // "If cost cannot be verified at execution time: do not execute."
    const gate = evaluateCostGate(estimateBackfillCost({ mastodon: 5 }), 1000);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toBe("unpriced_platform");
      expect(gate.message).toContain("mastodon");
    }
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
    expect(plan.cost.totalEstimatedUsd).toBe(0);
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
