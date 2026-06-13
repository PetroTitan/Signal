import "server-only";
/**
 * Phase C3.6 — metrics refresh orchestration.
 *
 * Fetches verified metrics for a published post and caches the result.
 * Respects rate limits by setting next_refresh_at (connected rows are
 * eligible to re-fetch after a cooldown; non-connected aren't auto-
 * retried). Logs failures via the cached `error` field. Reusable by a
 * manual operator action and by a future scheduled sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVerifiedMetrics } from "./fetch-metrics";
import type { MetricsResult } from "./metrics-provider";

/** Cooldown before a connected post's metrics are re-fetched. */
const CONNECTED_REFRESH_HOURS = 6;

export async function refreshPostMetrics(input: {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  externalPostId: string | null;
  permalink: string | null;
  db?: SupabaseClient;
}): Promise<MetricsResult> {
  const result = await fetchVerifiedMetrics({
    platform: input.platform,
    externalPostId: input.externalPostId,
    permalink: input.permalink,
  });

  const nextRefreshAt =
    result.status === "connected"
      ? new Date(Date.now() + CONNECTED_REFRESH_HOURS * 60 * 60 * 1000).toISOString()
      : null;

  // Persist best-effort — a cache write failure must not surface as a
  // page error; the fetched result is still returned to the caller.
  try {
    const { upsertPostMetrics } = await import(
      "@/repositories/post-metrics-repository"
    );
    await upsertPostMetrics({
      workspaceId: input.workspaceId,
      publishHistoryId: input.publishHistoryId,
      platform: input.platform,
      source: result.source,
      externalPostId: result.externalPostId,
      status: result.status,
      metrics: result.metrics as Record<string, unknown>,
      error: result.error ?? null,
      nextRefreshAt,
      db: input.db,
    });
  } catch (err) {
    console.error("[refresh-metrics] cache write failed (non-fatal)", err);
  }

  return result;
}
