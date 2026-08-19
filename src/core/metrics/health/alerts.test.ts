import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SNAPSHOT_STALE_HOURS,
  COVERAGE_ALERT_THRESHOLD,
  COVERAGE_MIN_SAMPLE,
  evaluateAlerts,
  worstSeverity,
  type AlertInput,
} from "./alerts";
import type { RefreshHealth } from "./refresh-health";
import type { CoverageSummary } from "../coverage";

const NOW = "2026-08-20T12:00:00.000Z";

function health(over: Partial<RefreshHealth> = {}): RefreshHealth {
  return {
    overall: "healthy",
    everRan: true,
    lastRunAt: "2026-08-20T06:00:00.000Z",
    lastRunPhase: "completed",
    lastRunTrigger: "cron",
    lastSuccessfulRunAt: "2026-08-20T06:00:00.000Z",
    hoursSinceLastRun: 6,
    hoursSinceLastSuccess: 6,
    expectedIntervalHours: 24,
    overdue: false,
    lastZeroReason: null,
    providers: [],
    evidence: ["Last run 6 hours ago."],
    summary: "Measurement is working.",
    ...over,
  };
}

function coverage(over: Partial<CoverageSummary> = {}): CoverageSummary {
  return {
    platform: "bluesky",
    accountId: "a1",
    publishAttempts: 13,
    publishedPosts: 13,
    measurablePosts: 13,
    postsWithFreshSnapshots: 13,
    postsMissingSnapshots: 0,
    coveragePercent: 100,
    oldestMissingPublishedAt: null,
    newestSuccessfulSnapshotAt: NOW,
    byState: {
      not_yet_due: 0, covered: 13, partially_covered: 0, stale: 0,
      provider_unavailable: 0, provider_error: 0, missing_provider_post_id: 0,
      outside_recoverable_window: 0,
    },
    backfillRecoverable: 0,
    summary: "ok",
    ...over,
  };
}

function input(over: Partial<AlertInput> = {}): AlertInput {
  return {
    health: health(),
    coverage: [coverage()],
    budget: null,
    accountSnapshotAgeHours: 2,
    hasSnapshottableAccounts: true,
    nowIso: NOW,
    ...over,
  };
}

describe("a healthy system is quiet", () => {
  it("raises nothing when everything is fine", () => {
    expect(evaluateAlerts(input())).toEqual([]);
    expect(worstSeverity([])).toBeNull();
  });
});

describe("run-level conditions", () => {
  it("never_run is critical and names the check", () => {
    const alerts = evaluateAlerts(
      input({ health: health({ overall: "never_run", everRan: false, overdue: true }) }),
    );
    const a = alerts.find((x) => x.key === "refresh_never_run")!;
    expect(a.severity).toBe("critical");
    expect(a.action).toContain("cron is registered");
  });

  it("a missing schema points at the migration", () => {
    const alerts = evaluateAlerts(
      input({ health: health({ overall: "configuration_error" }) }),
    );
    expect(alerts.find((x) => x.key === "schema_missing")!.action).toContain("migration");
  });

  it("overdue escalates to critical once stale", () => {
    const warn = evaluateAlerts(input({ health: health({ overdue: true, hoursSinceLastRun: 40 }) }));
    expect(warn.find((x) => x.key === "refresh_overdue")!.severity).toBe("warning");

    const crit = evaluateAlerts(
      input({ health: health({ overdue: true, overall: "stale", hoursSinceLastRun: 100 }) }),
    );
    expect(crit.find((x) => x.key === "refresh_overdue")!.severity).toBe("critical");
  });
});

describe("provider conditions stay per provider", () => {
  const providers = [
    { platform: "x", state: "provider_error" as const, lastSuccessfulReadAt: null, lastAttemptAt: NOW, consecutiveFailedRuns: 3, attemptedLastRun: 1, succeededLastRun: 0, evidence: "3 consecutive run(s) attempted reads and got nothing usable." },
    { platform: "bluesky", state: "healthy" as const, lastSuccessfulReadAt: NOW, lastAttemptAt: NOW, consecutiveFailedRuns: 0, attemptedLastRun: 1, succeededLastRun: 1, evidence: "1 of 1 read(s) returned data." },
  ];

  it("alerts on X without implicating Bluesky", () => {
    const alerts = evaluateAlerts(input({ health: health({ overall: "degraded", providers }) }));
    const failing = alerts.filter((a) => a.key === "provider_failing");
    expect(failing).toHaveLength(1);
    expect(failing[0].title).toContain("x");
    expect(alerts.some((a) => a.title.includes("bluesky"))).toBe(false);
  });

  it("rate limiting is info and says no action is needed", () => {
    const alerts = evaluateAlerts(
      input({
        health: health({
          providers: [{ ...providers[0], state: "rate_limited", evidence: "The provider rate-limited the last run." }],
        }),
      }),
    );
    const a = alerts.find((x) => x.key === "provider_rate_limited")!;
    expect(a.severity).toBe("info");
    expect(a.action).toContain("No action needed");
  });

  it("a billing refusal is critical and says waiting will not fix it", () => {
    const alerts = evaluateAlerts(
      input({
        health: health({
          providers: [{ ...providers[0], evidence: "X returned 403 client-not-enrolled — the project is not enrolled." }],
        }),
      }),
    );
    const a = alerts.find((x) => x.key === "x_billing_refused")!;
    expect(a.severity).toBe("critical");
    expect(a.action).toContain("Waiting will not clear this");
  });
});

describe("coverage conditions", () => {
  it("stays silent below the minimum sample", () => {
    const alerts = evaluateAlerts(
      input({
        coverage: [coverage({ measurablePosts: COVERAGE_MIN_SAMPLE - 1, coveragePercent: 0, postsWithFreshSnapshots: 0 })],
      }),
    );
    expect(alerts.some((a) => a.key === "coverage_below_threshold")).toBe(false);
  });

  it("fires below the threshold with enough sample", () => {
    const alerts = evaluateAlerts(
      input({
        coverage: [coverage({ measurablePosts: 13, postsWithFreshSnapshots: 0, coveragePercent: 0 })],
      }),
    );
    const a = alerts.find((x) => x.key === "coverage_below_threshold")!;
    expect(a.evidence).toContain("0 of 13");
    expect(COVERAGE_ALERT_THRESHOLD).toBeGreaterThan(0);
  });

  it("points at the backfill when that is the actual fix", () => {
    const alerts = evaluateAlerts(
      input({
        coverage: [coverage({ measurablePosts: 13, postsWithFreshSnapshots: 0, coveragePercent: 0, backfillRecoverable: 12 })],
      }),
    );
    expect(alerts.find((x) => x.key === "coverage_below_threshold")!.action).toContain("backfill");
    expect(alerts.some((x) => x.key === "backfill_recoverable_work")).toBe(true);
  });
});

describe("account context", () => {
  it("warns when none has ever been collected", () => {
    const alerts = evaluateAlerts(input({ accountSnapshotAgeHours: null }));
    const a = alerts.find((x) => x.key === "account_snapshots_stale")!;
    expect(a.severity).toBe("warning");
  });

  it("is quiet when there is nothing snapshottable", () => {
    const alerts = evaluateAlerts(
      input({ accountSnapshotAgeHours: null, hasSnapshottableAccounts: false }),
    );
    expect(alerts.some((a) => a.key === "account_snapshots_stale")).toBe(false);
  });

  it("downgrades merely-old context to info", () => {
    const alerts = evaluateAlerts(
      input({ accountSnapshotAgeHours: ACCOUNT_SNAPSHOT_STALE_HOURS + 10 }),
    );
    expect(alerts.find((x) => x.key === "account_snapshots_stale")!.severity).toBe("info");
  });
});

describe("ordering and shape", () => {
  it("sorts critical first", () => {
    const alerts = evaluateAlerts(
      input({
        health: health({ overall: "never_run", everRan: false, overdue: true }),
        coverage: [coverage({ measurablePosts: 13, postsWithFreshSnapshots: 0, coveragePercent: 0, backfillRecoverable: 5 })],
      }),
    );
    expect(alerts[0].severity).toBe("critical");
    expect(worstSeverity(alerts)).toBe("critical");
  });

  it("every alert names an action", () => {
    const alerts = evaluateAlerts(
      input({
        health: health({ overall: "never_run", everRan: false, overdue: true }),
        coverage: [coverage({ measurablePosts: 13, postsWithFreshSnapshots: 0, coveragePercent: 0 })],
        accountSnapshotAgeHours: null,
      }),
    );
    expect(alerts.length).toBeGreaterThan(2);
    for (const a of alerts) {
      expect(a.action.length, a.key).toBeGreaterThan(10);
      expect(a.evidence.length, a.key).toBeGreaterThan(10);
    }
  });
});
