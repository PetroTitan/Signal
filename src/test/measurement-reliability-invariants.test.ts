import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SweepReportBuilder, deriveZeroReason } from "@/core/metrics/refresh/sweep-report";
import { refreshStaleMetrics, type RefreshEngineDeps } from "@/core/metrics/refresh/refresh-engine";
import { collectAccountSnapshots } from "@/core/metrics/account-snapshot-collector";
import { classifyCoverage, summarizeCoverage } from "@/core/metrics/coverage";
import { planRefresh, planRefreshBatch } from "@/core/metrics/refresh-planner";
import {
  assessCost,
  evaluateBudget,
  evaluateSpend,
} from "@/core/metrics/budget/x-read-budget";
import { evaluateRefreshHealth } from "@/core/metrics/health/refresh-health";
import { resolveMetricCell, renderMetricCell } from "@/core/metrics/metric-availability";
import { isPresentableAsCurrent } from "@/core/metrics/freshness";
import { emptyState, isBannedEmptyPhrase } from "@/core/metrics/health/empty-states";
import { MAX_BACKFILL_POSTS, planBackfill } from "@/core/metrics/backfill/backfill-plan";

/**
 * MEASUREMENT RELIABILITY INVARIANTS.
 *
 * Behavioural wherever a behaviour can express the rule; static only for
 * architectural boundaries that cannot be exercised at runtime — a module
 * being unable to import a publisher is a fact about the file, not about
 * any call.
 */

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260819000002_metrics_refresh_runs.sql",
);
const NOW = "2026-08-20T12:00:00.000Z";

// =====================================================================
// 2 + 3. provider_error != zero, not_measured != zero
// =====================================================================

describe("INVARIANT — an error and an unmeasured post are never zero", () => {
  const base = {
    publishHistoryId: "p1",
    platform: "bluesky",
    accountId: "a1",
    outcome: "published",
    publishedAt: "2026-08-15T14:25:00Z",
    providerPostId: "at://x",
    permalink: null,
  };

  it("a provider error is provider_error, never covered and never zero", () => {
    const v = classifyCoverage(
      {
        ...base,
        metrics: { status: "unavailable", fetchedAt: NOW, freshness: "provider_error", ageWindow: null, counters: {} },
      },
      { nowIso: NOW, seedWindowDays: 14 },
    );
    expect(v.state).toBe("provider_error");
    expect(v.healthy).toBe(false);
    expect(emptyState("provider_error").message).toContain("It is not zero");
  });

  it("an unmeasured post is not covered and renders as not-measured", () => {
    const v = classifyCoverage({ ...base, metrics: null }, { nowIso: NOW, seedWindowDays: 14 });
    expect(v.healthy).toBe(false);
    const cell = resolveMetricCell("bluesky", "likes", null);
    expect(cell.kind).toBe("not_measured");
    expect(renderMetricCell(cell)).not.toBe("0");
  });

  it("no empty-state message is a generic placeholder", () => {
    for (const key of ["provider_error", "never_measured", "stale", "provider_does_not_expose"] as const) {
      expect(isBannedEmptyPhrase(emptyState(key).label)).toBe(false);
      expect(emptyState(key).message.length).toBeGreaterThan(30);
    }
  });
});

// =====================================================================
// 4 + 5. stale is never fresh; Bluesky impressions stay unavailable
// =====================================================================

describe("INVARIANT — stale is never fresh, Bluesky impressions never exist", () => {
  it("only fresh is presentable as current", () => {
    for (const f of ["stale", "unavailable", "rate_limited", "provider_error"] as const) {
      expect(isPresentableAsCurrent(f)).toBe(false);
    }
  });

  it("Bluesky impressions render as words in every path", () => {
    for (const metrics of [null, {}, { likes: 2 }, { impressions: 99 } as never]) {
      const cell = resolveMetricCell("bluesky", "impressions", metrics);
      expect(cell.kind).not.toBe("value");
      expect(renderMetricCell(cell)).not.toMatch(/^\d+$/);
    }
  });
});

// =====================================================================
// 6. account snapshots are workspace scoped
// =====================================================================

describe("INVARIANT — account snapshot writes carry the workspace", () => {
  it("every persisted row includes workspace_id", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      from() {
        return {
          select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
          upsert: async (row: Record<string, unknown>) => {
            upserts.push(row);
            return { error: null };
          },
        };
      },
    } as never;

    await collectAccountSnapshots(
      [{ workspaceId: "ws-1", accountId: "acct-1", platform: "bluesky", handle: "a.bsky.social" }],
      NOW,
      {
        db,
        readBluesky: vi.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            platform: "bluesky", handle: "a.bsky.social", providerAccountId: "did:x",
            followers: 1, following: 2, postCount: 3, createdAt: null,
            fetchedAt: NOW, source: "bluesky_getprofile",
          },
        }),
      },
    );

    expect(upserts.length).toBeGreaterThan(0);
    for (const row of upserts) {
      expect(row.workspace_id, JSON.stringify(row)).toBe("ws-1");
    }
  });
});

// =====================================================================
// 9. unknown X cost is never free
// =====================================================================

describe("INVARIANT — an unknown X price is not a free one", () => {
  const stale = { configuredRate: null, nowIso: "2027-06-01T00:00:00.000Z" };

  it("returns null, never 0, for an unpriced billable plan", () => {
    const a = assessCost({ x: 15 }, stale);
    expect(a.costKnown).toBe(false);
    expect(a.estimatedUsd).toBeNull();
    expect(a.estimatedUsd).not.toBe(0);
  });

  it("refuses to run automatically however large the dollar confirmation", () => {
    const v = evaluateSpend({
      assessment: assessCost({ x: 15 }, stale),
      budget: evaluateBudget(0, 500),
      confirmedMaxUsd: Number.MAX_SAFE_INTEGER,
    });
    expect(v.allowed).toBe(false);
  });

  it("still reports the resource count, which is always knowable", () => {
    expect(assessCost({ x: 15 }, stale).resources.xResources).toBe(15);
  });
});

// =====================================================================
// 8. backfill is bounded
// =====================================================================

describe("INVARIANT — a backfill is always bounded", () => {
  it("caps maxPosts however large the request", () => {
    const plan = planBackfill({
      candidates: [],
      bounds: { since: "2020-01-01T00:00:00Z", until: NOW, maxPosts: 1e9 },
    });
    expect(plan.bounds.maxPosts).toBe(MAX_BACKFILL_POSTS);
  });

  it("requires an explicit range", () => {
    const plan = planBackfill({
      candidates: [],
      bounds: { since: "2020-01-01T00:00:00Z", until: NOW },
    });
    expect(plan.bounds.since).toBeTruthy();
    expect(plan.bounds.until).toBeTruthy();
  });
});

// =====================================================================
// 10 + 13. provider isolation, and snapshots cannot corrupt post metrics
// =====================================================================

describe("INVARIANT — one provider failing cannot abort the others", () => {
  it("a thrown X profile read does not stop the Bluesky read", async () => {
    const db = {
      from() {
        return {
          select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
          upsert: async () => ({ error: null }),
        };
      },
    } as never;

    const result = await collectAccountSnapshots(
      [
        { workspaceId: "w", accountId: "x1", platform: "x", handle: null },
        { workspaceId: "w", accountId: "b1", platform: "bluesky", handle: "a.bsky.social" },
      ],
      NOW,
      {
        db,
        readX: vi.fn().mockRejectedValue(new Error("X exploded")),
        readBluesky: vi.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            platform: "bluesky", handle: "a.bsky.social", providerAccountId: null,
            followers: 1, following: 1, postCount: 1, createdAt: null,
            fetchedAt: NOW, source: "bluesky_getprofile",
          },
        }),
      },
    );
    expect(result.byPlatform.bluesky.written).toBe(1);
    expect(result.byPlatform.x.failed).toBe(1);
  });

  it("an account-snapshot failure never discards measured post metrics", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([
        { workspaceId: "w", publishHistoryId: "p", platform: "bluesky", externalPostId: "at://x", permalink: null, accountId: "a", handle: "h" },
      ]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn().mockResolvedValue({
        status: "connected", source: "bluesky_getposts", externalPostId: "at://x", metrics: { likes: 1 },
      }),
      collectAccountSnapshots: vi.fn().mockRejectedValue(new Error("profile API down")),
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.connected).toBe(1);
    expect(r.report.succeeded).toBe(1);
    expect(r.report.accountSnapshots.failed).toBe(1);
  });

  it("health reports one failing provider without condemning the rest", () => {
    const failing = { bluesky: { attempted: 1, connected: 1 }, x: { attempted: 1, connected: 0, failed: 1 } };
    const run = {
      runId: "r", trigger: "cron", phase: "completed", startedAt: "2026-08-20T06:00:00.000Z",
      finishedAt: null, durationMs: null, candidates: 2, attempted: 2, succeeded: 1, failed: 1,
      rateLimited: 0, snapshotsWritten: 1, accountSnapshotsWritten: 0, byProvider: failing,
      zeroReason: null, diagnosis: "ok",
    };
    const health = evaluateRefreshHealth({
      history: { lastRun: run, lastSuccessfulRun: run, recent: [run, { ...run, runId: "r0", startedAt: "2026-08-19T06:00:00.000Z" }], unavailable: false, unavailableReason: null },
      nowIso: NOW,
      verifiedPlatforms: ["bluesky", "x"],
    });
    expect(health.providers.find((p) => p.platform === "bluesky")!.state).toBe("healthy");
    expect(health.overall).toBe("degraded");
    expect(health.summary).not.toContain("broken");
  });
});

// =====================================================================
// 11. zero candidates must carry an explicit reason
// =====================================================================

describe("INVARIANT — no zero is ever unexplained", () => {
  it("every zero-read outcome names a reason", () => {
    const cases: Array<() => ReturnType<SweepReportBuilder["complete"]>> = [
      () => {
        const b = builder();
        b.recordLoader("stale", { ok: true, count: 0 });
        b.recordLoader("unmeasured", { ok: true, count: 0 });
        b.recordCandidates([]);
        b.recordPopulation(0, 0);
        return b.complete(NOW);
      },
      () => {
        const b = builder();
        b.recordLoader("stale", { ok: true, count: 0 });
        b.recordLoader("unmeasured", { ok: true, count: 0 });
        b.recordCandidates([]);
        b.recordPopulation(44, 0);
        return b.complete(NOW);
      },
      () => {
        const b = builder();
        b.recordLoader("stale", { ok: false, error: "denied" });
        b.recordLoader("unmeasured", { ok: false, error: "denied" });
        b.recordCandidates([]);
        return b.complete(NOW);
      },
      () => builder().fail(NOW, new Error("boom")),
    ];
    for (const make of cases) {
      const report = make();
      expect(report.succeeded).toBe(0);
      expect(report.zeroReason, report.diagnosis).not.toBeNull();
      expect(deriveZeroReason(report)).toBe(report.zeroReason);
    }
  });

  function builder() {
    return new SweepReportBuilder({
      runId: "r", startedAt: NOW, seedWindowDays: 14, staleLimit: 100, seedLimit: 50,
      verifiedPlatforms: ["bluesky", "x"],
    });
  }
});

// =====================================================================
// 12. execution failures are excluded from coverage
// =====================================================================

describe("INVARIANT — blocked and failed attempts are not coverage gaps", () => {
  it("excludes them from the denominator entirely", () => {
    const publications = [
      {
        publishHistoryId: "ok", platform: "bluesky", accountId: "a", outcome: "published",
        publishedAt: "2026-08-19T12:00:00Z", providerPostId: "at://x", permalink: null,
        metrics: { status: "connected", fetchedAt: NOW, freshness: "fresh", ageWindow: "24h", counters: { likes: 1, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 } },
      },
      ...["blocked", "failed"].map((outcome, i) => ({
        publishHistoryId: `bad${i}`, platform: "bluesky", accountId: "a", outcome,
        publishedAt: "2026-08-19T12:00:00Z", providerPostId: null, permalink: null, metrics: null,
      })),
    ];
    const [summary] = summarizeCoverage(publications, { nowIso: NOW, seedWindowDays: 14 });
    expect(summary.publishAttempts).toBe(3);
    expect(summary.publishedPosts).toBe(1);
    expect(summary.measurablePosts).toBe(1);
    expect(summary.coveragePercent).toBe(100);
  });
});

// =====================================================================
// 14. no measurement code can publish
// =====================================================================

describe("INVARIANT — measurement code cannot publish", () => {
  const MEASUREMENT_DIRS = [
    "src/core/metrics",
    "src/mcp/tools/measurement-health-tools.ts",
    "src/mcp/tools/social-intelligence-tools.ts",
  ];

  it("imports no publisher and calls no write endpoint", () => {
    const banned = [
      "publish-x", "publish-bluesky", "publishing-runner", "publishing-scheduler",
      "publishItemAction", "publishTierOneAction",
      "com.atproto.repo.createRecord", "/2/media/upload",
    ];
    const offenders: string[] = [];
    for (const file of collectFiles(MEASUREMENT_DIRS)) {
      if (file.endsWith(".test.ts")) continue;
      // Strip comments: these modules deliberately NAME the endpoints
      // they must never call, and a documented counterexample is the
      // opposite of a violation.
      const src = stripComments(readFileSync(file, "utf8"));
      for (const marker of banned) {
        if (src.includes(marker)) offenders.push(`${path.basename(file)}: ${marker}`);
      }
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("issues no HTTP method other than GET", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(["src/core/metrics"])) {
      if (file.endsWith(".test.ts")) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(/method:\s*"(\w+)"/g)) {
        if (m[1] !== "GET") offenders.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });
});

// =====================================================================
// Migration integrity
// =====================================================================

describe("the refresh-run migration is safe", () => {
  const sql = () => readFileSync(MIGRATION, "utf8");

  it("is additive — no drop, no rewrite", () => {
    const lower = sql().toLowerCase();
    expect(lower).not.toMatch(/drop table/);
    expect(lower).not.toMatch(/drop column/);
    expect(lower).not.toMatch(/^\s*update\s+public\./m);
    expect(lower).not.toMatch(/\bdelete from\b/);
    expect(lower).not.toMatch(/alter table public\.(publish_history|post_metrics|account_snapshots)/);
  });

  it("is idempotent where it should be", () => {
    expect(sql()).toContain("create table if not exists public.metrics_refresh_runs");
    for (const index of ["metrics_refresh_runs_started_idx", "metrics_refresh_runs_success_idx"]) {
      expect(sql()).toContain(`create index if not exists ${index}`);
    }
    expect(sql()).toContain("drop policy if exists");
  });

  it("enables RLS and restricts reads to workspace members", () => {
    expect(sql()).toContain("alter table public.metrics_refresh_runs enable row level security");
    expect(sql()).toContain("from public.workspace_members wm");
    expect(sql()).toContain("wm.user_id = auth.uid()");
  });

  it("declares no workspace_id, by design", () => {
    const table = /create table if not exists public\.metrics_refresh_runs \(([\s\S]*?)\n\);/.exec(sql());
    expect(table).toBeTruthy();
    expect(table![1]).not.toMatch(/workspace_id/);
  });

  it("constrains zero_reason to the derived vocabulary", () => {
    const literals = Array.from(
      /zero_reason in \(([\s\S]*?)\)\)/.exec(sql())![1].matchAll(/'([^']+)'/g),
    ).map((m) => m[1]).sort();
    expect(literals).toEqual(
      [
        "all_already_fresh", "all_outside_window", "all_skipped_no_identifier",
        "credentials_missing", "fatal_error", "provider_unavailable",
        "rate_limited", "workspace_query_failed", "zero_candidates",
      ].sort(),
    );
  });

  it("grants no write policy — runs are written by the system only", () => {
    expect(sql()).not.toMatch(/for insert/i);
    expect(sql()).not.toMatch(/for update/i);
  });
});

// =====================================================================

/** Remove comments so documentation is not mistaken for behaviour. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function collectFiles(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const full = path.join(process.cwd(), root);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
}
