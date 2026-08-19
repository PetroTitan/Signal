import { describe, expect, it } from "vitest";
import { assertNoIds, toRunInsert } from "./metrics-refresh-run-repository";
import { SweepReportBuilder, deriveZeroReason, describeZeroReason } from "@/core/metrics/refresh/sweep-report";

function builder(over: Partial<ConstructorParameters<typeof SweepReportBuilder>[0]> = {}) {
  return new SweepReportBuilder({
    runId: "run-1",
    startedAt: "2026-08-20T06:00:00.000Z",
    seedWindowDays: 14,
    staleLimit: 100,
    seedLimit: 50,
    verifiedPlatforms: ["bluesky", "devto", "reddit", "x"],
    ...over,
  });
}

describe("every run leaves a record, whatever happened", () => {
  it("a zero-candidate run still produces an insert with a reason", () => {
    // The exact hole this table closes: before it, this run wrote nothing.
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    b.recordPopulation(44, 0);
    const insert = toRunInsert(b.complete("2026-08-20T06:00:01.000Z"));

    expect(insert.run_id).toBe("run-1");
    expect(insert.phase).toBe("completed");
    expect(insert.publication_candidates).toBe(0);
    expect(insert.zero_reason).toBe("all_outside_window");
    expect(insert.diagnosis.length).toBeGreaterThan(20);
  });

  it("a failed run produces an insert too", () => {
    const insert = toRunInsert(builder().fail("2026-08-20T06:00:01.000Z", new Error("boom")));
    expect(insert.phase).toBe("failed");
    expect(insert.zero_reason).toBe("fatal_error");
    expect(insert.fatal_error).toBe("boom");
  });
});

describe("zero reasons are specific and exhaustive", () => {
  function zeroRun(opts: {
    staleOk?: boolean; unmeasuredOk?: boolean;
    candidates?: Array<{ workspaceId: string; platform: string }>;
    allTime?: number | null; inWindow?: number | null;
    skips?: number; reads?: Array<"failed" | "rate_limited" | "unavailable">;
  }) {
    const b = builder();
    b.recordLoader("stale", opts.staleOk === false ? { ok: false, error: "x" } : { ok: true, count: 0 });
    b.recordLoader("unmeasured", opts.unmeasuredOk === false ? { ok: false, error: "x" } : { ok: true, count: 0 });
    b.recordCandidates(opts.candidates ?? []);
    b.recordPopulation(opts.allTime ?? null, opts.inWindow ?? null);
    for (let i = 0; i < (opts.skips ?? 0); i += 1) {
      b.recordSkip({ workspaceId: "w", publishHistoryId: `p${i}`, platform: "x", reason: "no_provider_identifier" });
    }
    for (const [i, outcome] of (opts.reads ?? []).entries()) {
      b.recordRead({ workspaceId: "w", publishHistoryId: `r${i}`, platform: "x", outcome });
    }
    return b.complete("2026-08-20T06:00:01.000Z");
  }

  it("nothing published at all", () => {
    expect(zeroRun({ allTime: 0, inWindow: 0 }).zeroReason).toBe("zero_candidates");
  });

  it("everything older than the window — the real production case", () => {
    // 44 measurable publications exist, 0 inside the enrolment window.
    const r = zeroRun({ allTime: 44, inWindow: 0 });
    expect(r.zeroReason).toBe("all_outside_window");
    expect(describeZeroReason(r.zeroReason!)).toContain("bounded historical backfill");
  });

  it("everything in the window is already fresh", () => {
    expect(zeroRun({ allTime: 44, inWindow: 2 }).zeroReason).toBe("all_already_fresh");
  });

  it("both loaders failed", () => {
    expect(zeroRun({ staleOk: false, unmeasuredOk: false }).zeroReason).toBe("workspace_query_failed");
  });

  it("candidates existed but none was addressable", () => {
    expect(
      zeroRun({ candidates: [{ workspaceId: "w", platform: "x" }], skips: 1 }).zeroReason,
    ).toBe("all_skipped_no_identifier");
  });

  it("every read was rate limited", () => {
    expect(
      zeroRun({ candidates: [{ workspaceId: "w", platform: "x" }], reads: ["rate_limited"] }).zeroReason,
    ).toBe("rate_limited");
  });

  it("every read failed", () => {
    expect(
      zeroRun({ candidates: [{ workspaceId: "w", platform: "x" }], reads: ["failed"] }).zeroReason,
    ).toBe("provider_unavailable");
  });

  it("a successful run has NO zero reason", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 1 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([{ workspaceId: "w", platform: "bluesky" }]);
    b.recordRead({ workspaceId: "w", publishHistoryId: "p", platform: "bluesky", outcome: "connected" });
    expect(b.complete("2026-08-20T06:00:01.000Z").zeroReason).toBeNull();
  });

  it("NO ZERO IS EVER UNEXPLAINED", () => {
    // The invariant in one assertion: any run with zero successful reads
    // carries a reason, whatever combination produced it.
    const combos = [
      zeroRun({ allTime: 0, inWindow: 0 }),
      zeroRun({ allTime: 44, inWindow: 0 }),
      zeroRun({ allTime: 44, inWindow: 3 }),
      zeroRun({ staleOk: false, unmeasuredOk: false }),
      zeroRun({ candidates: [{ workspaceId: "w", platform: "x" }], skips: 2 }),
      zeroRun({ candidates: [{ workspaceId: "w", platform: "x" }], reads: ["unavailable"] }),
      zeroRun({}),
    ];
    for (const r of combos) {
      expect(r.succeeded).toBe(0);
      expect(r.zeroReason, JSON.stringify({ c: r.candidates, a: r.attempted })).not.toBeNull();
      expect(describeZeroReason(r.zeroReason!).length).toBeGreaterThan(10);
    }
  });

  it("deriveZeroReason is pure", () => {
    const r = zeroRun({ allTime: 44, inWindow: 0 });
    expect(deriveZeroReason(r)).toBe(deriveZeroReason(r));
  });
});

describe("the run record carries no identifiers", () => {
  it("drops workspace, post and failure identifiers", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 1 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([{ workspaceId: "11111111-1111-4111-8111-111111111111", platform: "x" }]);
    b.recordRead({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      publishHistoryId: "22222222-2222-4222-8222-222222222222",
      platform: "x",
      outcome: "failed",
      reason: "boom",
    });
    const insert = toRunInsert(b.complete("2026-08-20T06:00:01.000Z"));

    expect(assertNoIds(insert)).toBeNull();
    expect(JSON.stringify(insert)).not.toContain("11111111-1111");
    expect(JSON.stringify(insert)).not.toContain("22222222-2222");
    // The COUNT survives; the identity does not.
    expect(insert.workspace_count).toBe(1);
    expect(insert.by_provider).toHaveProperty("x");
  });

  it("assertNoIds catches a leak if one is ever introduced", () => {
    const leaked = { run_id: "r", phase: "completed" as const, started_at: "t", diagnosis: "workspace 33333333-3333-4333-8333-333333333333 failed" };
    expect(assertNoIds(leaked)).toBe("diagnosis");
  });

  it("permits a non-uuid run id", () => {
    expect(assertNoIds({ run_id: "sweep-2026-08-20", phase: "completed", started_at: "t", diagnosis: "ok" })).toBeNull();
  });
});

describe("provider breakdown", () => {
  it("reports each provider separately", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 2 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([
      { workspaceId: "w", platform: "bluesky" },
      { workspaceId: "w", platform: "x" },
    ]);
    b.recordRead({ workspaceId: "w", publishHistoryId: "a", platform: "bluesky", outcome: "connected" });
    b.recordRead({ workspaceId: "w", publishHistoryId: "b", platform: "x", outcome: "failed" });
    const insert = toRunInsert(b.complete("2026-08-20T06:00:01.000Z"));
    const byProvider = insert.by_provider as Record<string, { connected: number; failed: number }>;
    expect(byProvider.bluesky.connected).toBe(1);
    expect(byProvider.x.failed).toBe(1);
  });
});
