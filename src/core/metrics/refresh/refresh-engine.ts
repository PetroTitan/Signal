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
 */

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import {
  listStaleConnectedMetrics,
  listUnmeasuredPublishedPosts,
  type RefreshTarget,
} from "@/repositories/post-metrics-repository";
import { PLATFORM_METRIC_CAPABILITY } from "../metrics-provider";
import type { MetricsResult } from "../metrics-provider";
import { refreshPostMetrics } from "../refresh-metrics";

export interface RefreshEngineDeps {
  loadStale: (nowIso: string, limit: number) => Promise<RefreshTarget[]>;
  loadUnmeasured: (nowIso: string, limit: number) => Promise<RefreshTarget[]>;
  refreshOne: (target: RefreshTarget) => Promise<MetricsResult>;
}

export interface RefreshEngineOptions {
  now?: Date;
  staleLimit?: number;
  seedLimit?: number;
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

export async function refreshStaleMetrics(
  deps: RefreshEngineDeps,
  options: RefreshEngineOptions = {},
): Promise<RefreshEngineResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const staleLimit = Math.max(1, Math.min(500, options.staleLimit ?? 100));
  const seedLimit = Math.max(0, Math.min(500, options.seedLimit ?? 50));

  // 1 + 2 — gather targets (best-effort; a loader failure yields []).
  const [stale, unmeasured] = await Promise.all([
    deps.loadStale(nowIso, staleLimit).catch((err) => {
      console.error("[refresh-engine] loadStale failed", err);
      return [] as RefreshTarget[];
    }),
    seedLimit > 0
      ? deps.loadUnmeasured(nowIso, seedLimit).catch((err) => {
          console.error("[refresh-engine] loadUnmeasured failed", err);
          return [] as RefreshTarget[];
        })
      : Promise.resolve([] as RefreshTarget[]),
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

  const byPlatform: Record<string, RefreshPlatformTally> = {};
  const results: RefreshEngineResult["results"] = [];
  let connected = 0;
  let unavailable = 0;
  let unsupported = 0;
  let failed = 0;

  for (const target of targets) {
    const tally = (byPlatform[target.platform] ??= emptyTally());
    tally.scanned += 1;
    try {
      const result = await deps.refreshOne(target);
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
  const seedWindowDays = Math.max(1, opts.seedWindowDays ?? 14);
  const platforms = verifiedPlatforms();
  return {
    loadStale: (nowIso, limit) => listStaleConnectedMetrics(db, nowIso, limit),
    loadUnmeasured: (nowIso, limit) => {
      const sinceIso = new Date(
        new Date(nowIso).getTime() - seedWindowDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      return listUnmeasuredPublishedPosts(db, platforms, sinceIso, limit);
    },
    refreshOne: (target) =>
      refreshPostMetrics({
        workspaceId: target.workspaceId,
        publishHistoryId: target.publishHistoryId,
        platform: target.platform,
        externalPostId: target.externalPostId,
        permalink: target.permalink,
        db,
      }),
  };
}
