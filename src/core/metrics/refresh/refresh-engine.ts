import "server-only";
/**
 * Phase D.1B — metrics refresh engine (batch sweep).
 *
 * Re-fetches verified metrics for posts that are due, and seeds a first
 * fetch for newly-published posts on verified platforms. Deterministic,
 * retry-safe, idempotent, and isolated from the publishing scheduler:
 *
 *   1. Load STALE canonical rows (status='connected', next_refresh_at <= now).
 *   2. Load UNMEASURED published posts on verified platforms (no row yet).
 *   3. Dedupe + group by platform (sorted → deterministic order).
 *   4. Dispatch each to the per-post refresher (real provider fetch).
 *   5. The persist layer stores ONLY provider-returned values and never
 *      overwrites verified counts with empties; connected fetches append
 *      an immutable history snapshot.
 *
 * Idempotency: after a successful refresh next_refresh_at moves forward,
 * so a second sweep at the same instant finds nothing due; snapshots are
 * hour-bucketed. The engine NEVER throws for one post — failures are
 * captured per post so one bad fetch can't sink the sweep.
 *
 * All I/O is injected via `RefreshEngineDeps`, so the orchestration is
 * pure and unit-testable; `buildLiveRefreshDeps` wires the real
 * service-role repositories + the per-post refresher.
 *
 * OBSERVABILITY (this milestone)
 * ------------------------------
 * Every run now emits a `SweepReport`. This engine previously swallowed
 * loader failures into `[]`, which made "the database rejected the
 * query" indistinguishable from "there was nothing to do" — both
 * produced `scanned: 0`. That ambiguity is why `post_metrics` sat empty
 * in production for two months with nobody able to say why. Loader
 * outcomes, skips, rate limits and per-platform failures are now all
 * recorded, and `report.diagnosis` states the cause in one sentence.
 */

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import {
  countMeasurablePublications,
  listStaleConnectedMetrics,
  listUnmeasuredPublishedPosts,
  type RefreshTarget,
} from "@/repositories/post-metrics-repository";
import { PLATFORM_METRIC_CAPABILITY } from "../metrics-provider";
import type { MetricsResult } from "../metrics-provider";
import { refreshPostMetrics } from "../refresh-metrics";
import { collectAccountSnapshots } from "../account-snapshot-collector";
import {
  SweepReportBuilder,
  type ReadOutcome,
  type SweepReport,
} from "./sweep-report";

/** Default enrolment lookback for the SCHEDULED sweep. Steady-state
 *  value: a daily cron only ever needs to notice recent publications.
 *  Anything older is the bounded historical backfill's job, not this
 *  one's — see `src/core/metrics/backfill/`. */
export const DEFAULT_SEED_WINDOW_DAYS = 14;

export interface RefreshEngineDeps {
  loadStale: (nowIso: string, limit: number) => Promise<RefreshTarget[]>;
  loadUnmeasured: (nowIso: string, limit: number) => Promise<RefreshTarget[]>;
  refreshOne: (target: RefreshTarget) => Promise<MetricsResult>;
  /**
   * Population context, so a zero-candidate run can say WHICH kind of
   * zero it is. Optional: an engine wired without it still runs, it just
   * reports a less specific reason.
   */
  countPopulation?: (
    nowIso: string,
  ) => Promise<{ allTime: number | null; inWindow: number | null }>;
  /** Collect account-level context. Optional; failures are isolated. */
  collectAccountSnapshots?: (
    targets: readonly RefreshTarget[],
    nowIso: string,
  ) => Promise<{ written: number; failed: number; attempted: number }>;
}

export interface RefreshEngineOptions {
  now?: Date;
  trigger?: "cron" | "manual" | "backfill" | "smoke_test";
  staleLimit?: number;
  seedLimit?: number;
  /** Reported (not applied) here — the window itself lives in the
   *  injected loader. Surfaced so the report can explain an empty run. */
  seedWindowDays?: number;
  runId?: string;
}

export interface RefreshPlatformTally {
  scanned: number;
  connected: number;
  unavailable: number;
  unsupported: number;
  failed: number;
}

export interface RefreshEngineResult {
  ok: true;
  ranAt: string;
  scanned: number;
  connected: number;
  unavailable: number;
  unsupported: number;
  failed: number;
  byPlatform: Record<string, RefreshPlatformTally>;
  results: Array<{
    workspaceId: string;
    publishHistoryId: string;
    platform: string;
    status: MetricsResult["status"] | "failed";
    error?: string | null;
  }>;
  /** Structured observability record for this run. */
  report: SweepReport;
}

function emptyTally(): RefreshPlatformTally {
  return { scanned: 0, connected: 0, unavailable: 0, unsupported: 0, failed: 0 };
}

/** Verified platforms, sorted — the only ones worth seeding/fetching. */
export function verifiedPlatforms(): string[] {
  return Object.entries(PLATFORM_METRIC_CAPABILITY)
    .filter(([, c]) => c === "verified")
    .map(([p]) => p)
    .sort();
}

/**
 * A target is actionable only if it carries something a fetcher can key
 * off. Reddit resolves from the permalink; every other verified platform
 * needs the provider post id. Skipping these explicitly (rather than
 * letting the fetcher return a vague `unavailable`) is what lets the
 * report say "these N posts have no provider identifier" instead of
 * "N posts are unavailable for unknown reasons".
 */
export function hasProviderIdentifier(target: RefreshTarget): boolean {
  return Boolean(target.externalPostId ?? target.permalink);
}

function classify(result: MetricsResult): ReadOutcome {
  if (result.rateLimited) return "rate_limited";
  if (result.status === "connected") return "connected";
  if (result.status === "unsupported") return "unsupported";
  return "unavailable";
}

export async function refreshStaleMetrics(
  deps: RefreshEngineDeps,
  options: RefreshEngineOptions = {},
): Promise<RefreshEngineResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const staleLimit = Math.max(1, Math.min(500, options.staleLimit ?? 100));
  const seedLimit = Math.max(0, Math.min(500, options.seedLimit ?? 50));

  const builder = new SweepReportBuilder({
    runId: options.runId ?? `sweep-${nowIso}`,
    trigger: options.trigger ?? "cron",
    startedAt: nowIso,
    seedWindowDays: options.seedWindowDays ?? DEFAULT_SEED_WINDOW_DAYS,
    staleLimit,
    seedLimit,
    verifiedPlatforms: verifiedPlatforms(),
  });

  // 1 + 2 — gather targets. A loader failure still yields [] so the run
  // continues, but it is now RECORDED rather than silently absorbed.
  const [stale, unmeasured] = await Promise.all([
    deps
      .loadStale(nowIso, staleLimit)
      .then((rows) => {
        builder.recordLoader("stale", { ok: true, count: rows.length });
        return rows;
      })
      .catch((err) => {
        console.error("[refresh-engine] loadStale failed", err);
        builder.recordLoader("stale", { ok: false, error: err });
        return [] as RefreshTarget[];
      }),
    seedLimit > 0
      ? deps
          .loadUnmeasured(nowIso, seedLimit)
          .then((rows) => {
            builder.recordLoader("unmeasured", { ok: true, count: rows.length });
            return rows;
          })
          .catch((err) => {
            console.error("[refresh-engine] loadUnmeasured failed", err);
            builder.recordLoader("unmeasured", { ok: false, error: err });
            return [] as RefreshTarget[];
          })
      : Promise.resolve([] as RefreshTarget[]).then((rows) => {
          builder.recordLoader("unmeasured", { ok: true, count: 0 });
          return rows;
        }),
  ]);

  // 3 — dedupe by publish_history_id (a post measured twice is one job),
  // then group by platform with deterministic ordering.
  const byId = new Map<string, RefreshTarget>();
  for (const t of [...unmeasured, ...stale]) {
    if (!byId.has(t.publishHistoryId)) byId.set(t.publishHistoryId, t);
  }
  const targets = Array.from(byId.values()).sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.publishHistoryId.localeCompare(b.publishHistoryId),
  );
  builder.recordCandidates(targets);

  // Population context. Best-effort and never fatal — its only job is to
  // let a zero-candidate run name which kind of zero it is.
  if (deps.countPopulation) {
    try {
      const population = await deps.countPopulation(nowIso);
      builder.recordPopulation(population.allTime, population.inWindow);
    } catch (err) {
      console.error("[refresh-engine] countPopulation failed (non-fatal)", err);
      builder.recordPopulation(null, null);
    }
  }

  const byPlatform: Record<string, RefreshPlatformTally> = {};
  const results: RefreshEngineResult["results"] = [];
  let connected = 0;
  let unavailable = 0;
  let unsupported = 0;
  let failed = 0;

  for (const target of targets) {
    const tally = (byPlatform[target.platform] ??= emptyTally());
    tally.scanned += 1;

    if (!hasProviderIdentifier(target)) {
      builder.recordSkip({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        reason: "no_provider_identifier",
      });
      unavailable += 1;
      tally.unavailable += 1;
      results.push({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        status: "unavailable",
        error: "no provider identifier",
      });
      continue;
    }

    try {
      const result = await deps.refreshOne(target);
      builder.recordRead({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        outcome: classify(result),
        reason: result.error,
      });
      if (result.status === "connected") {
        connected += 1;
        tally.connected += 1;
      } else if (result.status === "unavailable" || result.status === "pending") {
        unavailable += 1;
        tally.unavailable += 1;
      } else {
        unsupported += 1;
        tally.unsupported += 1;
      }
      results.push({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        status: result.status,
        error: result.error ?? null,
      });
    } catch (err) {
      failed += 1;
      tally.failed += 1;
      builder.recordRead({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        outcome: "failed",
        reason: err,
      });
      console.error(
        "[refresh-engine] refreshOne failed (non-fatal)",
        target.platform,
        target.publishHistoryId,
        err,
      );
      results.push({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        status: "failed",
        error: err instanceof Error ? err.message : "refresh failed",
      });
    }
  }

  // Account-context collection shares this orchestration rather than
  // running on its own cron. Isolated in its own try: a follower-count
  // failure must never discard the post measurements just written.
  if (deps.collectAccountSnapshots) {
    try {
      const accounts = await deps.collectAccountSnapshots(targets, nowIso);
      for (let i = 0; i < accounts.written; i += 1) builder.recordAccountSnapshot("written");
      for (let i = 0; i < accounts.failed; i += 1) builder.recordAccountSnapshot("failed");
    } catch (err) {
      console.error("[refresh-engine] account snapshots failed (non-fatal)", err);
      builder.recordAccountSnapshot("failed");
    }
  }

  const report = builder.complete(new Date().toISOString());

  return {
    ok: true,
    ranAt: nowIso,
    scanned: targets.length,
    connected,
    unavailable,
    unsupported,
    failed,
    byPlatform,
    results,
    report,
  };
}

/**
 * Wire the real service-role repositories + per-post refresher. Returns
 * null when the service-role client is unavailable (the cron runs as the
 * system and cannot fall back to a cookie-aware client).
 */
export function buildLiveRefreshDeps(
  opts: { seedWindowDays?: number } = {},
): RefreshEngineDeps | null {
  const db = createSupabaseServiceRoleClient();
  if (!db) return null;
  const seedWindowDays = Math.max(1, opts.seedWindowDays ?? DEFAULT_SEED_WINDOW_DAYS);
  const platforms = verifiedPlatforms();
  return {
    countPopulation: (nowIso) =>
      countMeasurablePublications(
        db,
        platforms,
        new Date(new Date(nowIso).getTime() - seedWindowDays * 86_400_000).toISOString(),
      ),
    loadStale: (nowIso, limit) => listStaleConnectedMetrics(db, nowIso, limit),
    loadUnmeasured: (nowIso, limit) => {
      const sinceIso = new Date(
        new Date(nowIso).getTime() - seedWindowDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      return listUnmeasuredPublishedPosts(db, platforms, sinceIso, limit);
    },
    // Account context shares this orchestration rather than getting its
    // own cron. See account-snapshot-collector for the cadence rationale.
    collectAccountSnapshots: async (targets, nowIso) => {
      const result = await collectAccountSnapshots(
        targets.map((t) => ({
          workspaceId: t.workspaceId,
          accountId: t.accountId ?? "",
          platform: t.platform,
          handle: t.handle ?? null,
        })),
        nowIso,
        { db },
      );
      return {
        attempted: result.attempted,
        written: result.written,
        failed: result.failed,
      };
    },
    refreshOne: (target) =>
      refreshPostMetrics({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        externalPostId: target.externalPostId,
        permalink: target.permalink,
        accountId: target.accountId,
        db,
      }),
  };
}
