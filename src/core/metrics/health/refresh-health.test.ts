import { describe, expect, it } from "vitest";
import {
  EXPECTED_INTERVAL_HOURS,
  PROVIDER_FAILURE_STREAK,
  evaluateProvider,
  evaluateRefreshHealth,
} from "./refresh-health";
import type { RefreshRunHistory, RefreshRunSummary } from "@/repositories/metrics-refresh-run-repository";

const NOW = "2026-08-20T12:00:00.000Z";
const PLATFORMS = ["bluesky", "devto", "reddit", "x"];

function run(over: Partial<RefreshRunSummary> = {}): RefreshRunSummary {
  return {
    runId: "r1",
    trigger: "cron",
    phase: "completed",
    startedAt: "2026-08-20T06:00:00.000Z",
    finishedAt: "2026-08-20T06:00:05.000Z",
    durationMs: 5000,
    candidates: 2,
    attempted: 2,
    succeeded: 2,
    failed: 0,
    rateLimited: 0,
    snapshotsWritten: 2,
    accountSnapshotsWritten: 2,
    byProvider: { bluesky: { attempted: 1, connected: 1 }, x: { attempted: 1, connected: 1 } },
    zeroReason: null,
    diagnosis: "ok",
    ...over,
  };
}

function history(runs: RefreshRunSummary[]): RefreshRunHistory {
  return {
    lastRun: runs[0] ?? null,
    lastSuccessfulRun: runs.find((r) => r.phase === "completed" && r.succeeded > 0) ?? null,
    recent: runs,
    unavailable: false,
    unavailableReason: null,
  };
}

const evaluate = (h: RefreshRunHistory, nowIso = NOW) =>
  evaluateRefreshHealth({ history: h, nowIso, verifiedPlatforms: PLATFORMS });

describe("never run is its own state", () => {
  it("reports never_run, not unhealthy", () => {
    const h = evaluate(history([]));
    expect(h.overall).toBe("never_run");
    expect(h.everRan).toBe(false);
    expect(h.summary).toBe("Measurement has never run.");
    expect(h.evidence[0]).toContain("has not fired");
  });

  it("marks every provider never_run rather than failing", () => {
    for (const p of evaluate(history([])).providers) {
      expect(p.state).toBe("never_run");
    }
  });
});

describe("schema and database problems are distinguished", () => {
  it("a missing table reads as configuration_error", () => {
    const h = evaluate({
      lastRun: null, lastSuccessfulRun: null, recent: [],
      unavailable: true,
      unavailableReason: 'relation "public.metrics_refresh_runs" does not exist',
    });
    expect(h.overall).toBe("configuration_error");
    expect(h.evidence[0]).toContain("migration");
  });

  it("any other read failure reads as database_error", () => {
    const h = evaluate({
      lastRun: null, lastSuccessfulRun: null, recent: [],
      unavailable: true, unavailableReason: "permission denied",
    });
    expect(h.overall).toBe("database_error");
  });

  it("a run whose loaders failed reads as database_error, not provider_error", () => {
    const h = evaluate(history([run({ succeeded: 0, attempted: 0, candidates: 0, zeroReason: "workspace_query_failed", byProvider: {} })]));
    expect(h.overall).toBe("database_error");
  });
});

describe("PROVIDER ISOLATION", () => {
  it("X failing does not make Bluesky unhealthy", () => {
    const failing = {
      bluesky: { attempted: 1, connected: 1 },
      x: { attempted: 1, connected: 0, failed: 1 },
    };
    const h = evaluate(history([
      run({ byProvider: failing, succeeded: 1, failed: 1 }),
      run({ runId: "r0", startedAt: "2026-08-19T06:00:00.000Z", byProvider: failing, succeeded: 1, failed: 1 }),
    ]));

    const x = h.providers.find((p) => p.platform === "x")!;
    const bsky = h.providers.find((p) => p.platform === "bluesky")!;
    expect(x.state).toBe("provider_error");
    expect(bsky.state).toBe("healthy");
    // The whole point: overall is degraded, never "broken".
    expect(h.overall).toBe("degraded");
    expect(h.summary).toContain("partly working");
    expect(h.summary).toContain("x: provider_error");
    expect(h.summary).toContain("bluesky: healthy");
  });

  it("only reports provider_error when ALL active providers fail", () => {
    const allFail = {
      bluesky: { attempted: 1, connected: 0, failed: 1 },
      x: { attempted: 1, connected: 0, failed: 1 },
    };
    const h = evaluate(history([
      run({ byProvider: allFail, succeeded: 0, failed: 2, zeroReason: "provider_unavailable" }),
      run({ runId: "r0", startedAt: "2026-08-19T06:00:00.000Z", byProvider: allFail, succeeded: 0, failed: 2, zeroReason: "provider_unavailable" }),
    ]));
    expect(h.overall).toBe("provider_error");
  });

  it("one bad run is not an incident — the streak threshold holds", () => {
    const h = evaluate(history([
      run({ byProvider: { x: { attempted: 1, connected: 0, failed: 1 } }, succeeded: 0, failed: 1 }),
    ]));
    const x = h.providers.find((p) => p.platform === "x")!;
    expect(x.state).toBe("degraded");
    expect(x.consecutiveFailedRuns).toBe(1);
    expect(x.evidence).toContain(`below the ${PROVIDER_FAILURE_STREAK}-run threshold`);
  });

  it("a provider that was never attempted is not failing", () => {
    // devto and reddit have no publications; they must not read as errors.
    const h = evaluate(history([run()]));
    const devto = h.providers.find((p) => p.platform === "devto")!;
    expect(devto.state).toBe("never_run");
    expect(devto.evidence).toContain("No read has been attempted");
    expect(h.overall).toBe("healthy");
  });

  it("rate limiting is reported as retryable, not as an error", () => {
    const rl = { x: { attempted: 2, connected: 0, rateLimited: 2 } };
    const h = evaluate(history([
      run({ byProvider: rl, succeeded: 0, rateLimited: 2, zeroReason: "rate_limited" }),
      run({ runId: "r0", startedAt: "2026-08-19T06:00:00.000Z", byProvider: rl, succeeded: 0, rateLimited: 2, zeroReason: "rate_limited" }),
    ]));
    expect(h.providers.find((p) => p.platform === "x")!.state).toBe("rate_limited");
    expect(h.overall).toBe("rate_limited");
    expect(h.summary).toContain("rate limited");
  });

  it("evaluateProvider reads only its own counters", () => {
    const runs = [run({ byProvider: { x: { attempted: 5, connected: 5 }, bluesky: { attempted: 5, connected: 0, failed: 5 } } })];
    expect(evaluateProvider("x", runs, NOW).state).toBe("healthy");
    expect(evaluateProvider("x", runs, NOW).succeededLastRun).toBe(5);
  });
});

describe("staleness", () => {
  it("a run older than two intervals is stale", () => {
    const h = evaluate(history([run({ startedAt: "2026-08-17T06:00:00.000Z" })]));
    expect(h.overall).toBe("stale");
    expect(h.overdue).toBe(true);
  });

  it("a recent run is not stale", () => {
    expect(evaluate(history([run()])).overall).toBe("healthy");
    expect(evaluate(history([run()])).overdue).toBe(false);
  });

  it("flags overdue before it flags stale", () => {
    // 1.5x interval: overdue, but still trusted.
    const h = evaluate(history([run({ startedAt: "2026-08-18T22:00:00.000Z" })]));
    expect(h.overdue).toBe(true);
    expect(h.expectedIntervalHours).toBe(EXPECTED_INTERVAL_HOURS);
  });
});

describe("benign zeros are healthy, meaningful zeros are not", () => {
  it("an empty backlog is healthy", () => {
    const h = evaluate(history([run({ succeeded: 0, attempted: 0, candidates: 0, byProvider: {}, zeroReason: "all_already_fresh" })]));
    expect(h.overall).toBe("healthy");
    expect(h.summary).toContain("nothing due to measure");
  });

  it("nothing ever published is healthy, not broken", () => {
    const h = evaluate(history([run({ succeeded: 0, attempted: 0, candidates: 0, byProvider: {}, zeroReason: "zero_candidates" })]));
    expect(h.overall).toBe("healthy");
  });

  it("everything outside the window is degraded — real work is unreachable", () => {
    // The production situation: 44 measurable publications, none in window.
    const h = evaluate(history([run({ succeeded: 0, attempted: 0, candidates: 0, byProvider: {}, zeroReason: "all_outside_window" })]));
    expect(h.overall).toBe("degraded");
    expect(h.lastZeroReason).toBe("all_outside_window");
  });
});

describe("evidence", () => {
  it("always says when it last ran and last succeeded", () => {
    const h = evaluate(history([run()]));
    expect(h.evidence.join(" ")).toContain("Last run");
    expect(h.evidence.join(" ")).toContain("Last run that measured something");
    expect(h.hoursSinceLastRun).toBe(6);
  });

  it("says plainly when nothing has ever succeeded", () => {
    const h = evaluate(history([run({ succeeded: 0, attempted: 1, failed: 1, byProvider: { x: { attempted: 1, connected: 0, failed: 1 } } })]));
    expect(h.evidence.join(" ")).toContain("No run has ever measured anything");
    expect(h.lastSuccessfulRunAt).toBeNull();
  });

  it("is deterministic", () => {
    const h = history([run()]);
    expect(JSON.stringify(evaluate(h))).toBe(JSON.stringify(evaluate(h)));
  });
});
