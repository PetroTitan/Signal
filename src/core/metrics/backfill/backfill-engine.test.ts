import { describe, expect, it, vi } from "vitest";
import { executePlan, type BackfillDeps } from "./backfill-engine";
import { planBackfill, type BackfillCandidate } from "./backfill-plan";
import type { MetricsResult } from "../metrics-provider";

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    workspaceId: "w1",
    publishHistoryId: "ph1",
    platform: "bluesky",
    externalPostId: "at://did/app.bsky.feed.post/1",
    permalink: null,
    publishedAt: "2026-06-01T12:00:00.000Z",
    alreadyMeasured: false,
    ...over,
  };
}

const RANGE = { since: "2026-01-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" };
const RUN = { runId: "run-1", startedAt: "2026-08-19T10:00:00.000Z", nowIso: "2026-08-19T10:00:05.000Z" };

function connected(): MetricsResult {
  return {
    status: "connected",
    source: "bluesky_getposts",
    externalPostId: "at://x",
    metrics: { likes: 2, replies: 0 },
  };
}

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    fetchOne: vi.fn().mockResolvedValue(connected()),
    persist: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("executePlan", () => {
  it("refuses a plan whose spend gate is closed, even if called directly", async () => {
    // Defence in depth: the planner already gates, but a function that
    // spends money must not trust an upstream check.
    const plan = planBackfill({
      candidates: [candidate({ platform: "x" })],
      bounds: RANGE,
    });
    const d = deps();
    const r = await executePlan(plan, d, RUN);
    expect(r.executed).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.refusal).toContain("confirmedMaxUsd");
    expect(d.fetchOne).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("touches no provider when there is nothing in range", async () => {
    const plan = planBackfill({ candidates: [], bounds: RANGE });
    const d = deps();
    const r = await executePlan(plan, d, RUN);
    expect(r.executed).toBe(false);
    expect(r.ok).toBe(true);
    expect(d.fetchOne).not.toHaveBeenCalled();
    expect(r.summary).toContain("Nothing to backfill");
  });

  it("reads and persists every selected post, reporting per-platform progress", async () => {
    const plan = planBackfill({
      candidates: [
        candidate({ publishHistoryId: "a" }),
        candidate({ publishHistoryId: "b" }),
      ],
      bounds: RANGE,
    });
    const d = deps();
    const r = await executePlan(plan, d, RUN);
    expect(r.executed).toBe(true);
    expect(r.attempted).toBe(2);
    expect(r.measured).toBe(2);
    expect(d.persist).toHaveBeenCalledTimes(2);
    expect(r.byPlatform.bluesky.measured).toBe(2);
    expect(r.byPlatform.bluesky.batches).toBe(1);
  });

  it("counts a rate-limited read as unmeasured and tells the operator to re-run", async () => {
    const plan = planBackfill({ candidates: [candidate()], bounds: RANGE });
    const r = await executePlan(
      plan,
      deps({
        fetchOne: vi.fn().mockResolvedValue({
          status: "unavailable",
          source: "bluesky_getposts",
          externalPostId: "at://x",
          metrics: {},
          rateLimited: true,
          error: "provider rate limit (429)",
        } satisfies MetricsResult),
      }),
      RUN,
    );
    expect(r.measured).toBe(0);
    expect(r.rateLimited).toBe(1);
    expect(r.summary).toContain("re-run the same range");
  });

  it("a persist failure is recorded as a failure, never as a measurement", async () => {
    const plan = planBackfill({ candidates: [candidate()], bounds: RANGE });
    const r = await executePlan(
      plan,
      deps({ persist: vi.fn().mockRejectedValue(new Error("db write refused")) }),
      RUN,
    );
    expect(r.measured).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.outcomes[0].measured).toBe(false);
    expect(r.outcomes[0].error).toContain("db write refused");
  });

  it("one bad post does not sink the run", async () => {
    const plan = planBackfill({
      candidates: [
        candidate({ publishHistoryId: "good" }),
        candidate({ publishHistoryId: "bad" }),
      ],
      bounds: RANGE,
    });
    const fetchOne = vi
      .fn()
      .mockImplementation((c: BackfillCandidate) =>
        c.publishHistoryId === "bad"
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(connected()),
      );
    const r = await executePlan(plan, deps({ fetchOne }), RUN);
    expect(r.ok).toBe(true);
    expect(r.measured).toBe(1);
    expect(r.failed).toBe(1);
  });

  it("redacts credentials that arrive through a provider error", async () => {
    const plan = planBackfill({ candidates: [candidate()], bounds: RANGE });
    const r = await executePlan(
      plan,
      deps({ fetchOne: vi.fn().mockRejectedValue(new Error("401 Bearer sk-live-SECRET12345")) }),
      RUN,
    );
    expect(JSON.stringify(r)).not.toContain("sk-live-SECRET12345");
  });

  it("runs a confirmed paid X plan", async () => {
    const plan = planBackfill({
      candidates: [candidate({ platform: "x", externalPostId: "12345" })],
      bounds: RANGE,
      confirmedMaxUsd: 1,
    });
    expect(plan.gate.allowed).toBe(true);
    const r = await executePlan(plan, deps(), RUN);
    expect(r.executed).toBe(true);
    expect(r.attempted).toBe(1);
  });

  it("is retry-safe — a second identical run repeats the same reads and writes", async () => {
    const plan = planBackfill({
      candidates: [candidate({ publishHistoryId: "a", alreadyMeasured: false })],
      bounds: RANGE,
    });
    const first = await executePlan(plan, deps(), RUN);
    const second = await executePlan(plan, deps(), RUN);
    // Idempotency is enforced by the upsert keys in the persist layer;
    // the engine's contract is simply that a re-run is safe and stable.
    expect(second.attempted).toBe(first.attempted);
    expect(second.measured).toBe(first.measured);
  });
});
