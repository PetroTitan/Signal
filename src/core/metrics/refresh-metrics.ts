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
import { resolveAge } from "./age-windows";
import { fetchVerifiedMetrics } from "./fetch-metrics";
import { classifyConfidence, classifyFreshness } from "./freshness";
import { availableMetrics } from "./metric-availability";
import type { MetricsResult } from "./metrics-provider";

/** Cooldown before a connected post's metrics are re-fetched. */
const CONNECTED_REFRESH_HOURS = 6;

export async function refreshPostMetrics(input: {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  externalPostId: string | null;
  permalink: string | null;
  /** Publishing identity — X needs it to resolve a user-context token. */
  accountId?: string | null;
  db?: SupabaseClient;
}): Promise<MetricsResult> {
  const result = await fetchVerifiedMetrics({
    platform: input.platform,
    externalPostId: input.externalPostId,
    permalink: input.permalink,
    // Only X consults this. Without a db client there is no way to reach
    // a token, so the X path reports `unavailable` with a reason rather
    // than silently returning nothing.
    auth: input.db
      ? {
          db: input.db,
          workspaceId: input.workspaceId,
          accountId: input.accountId ?? null,
        }
      : null,
  });

  // Connected → eligible to re-fetch after the cooldown. A non-connected
  // fetch that PRESERVES prior verified data should also be retried, so
  // we still pass a next_refresh_at; persistRefreshedMetrics decides
  // whether it lands on a connected (or preserved-connected) row.
  const nextRefreshAt = new Date(
    Date.now() + CONNECTED_REFRESH_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Provenance for this reading. `providerPublishedAt` comes from the
  // provider's own timestamp when it supplied one; falling back to
  // publish_history.finished_at would silently shift every age by the
  // publish latency, so an absent provider timestamp yields a null age
  // rather than an approximate one.
  const fetchedAtIso = new Date().toISOString();
  const { ageHours, ageWindow } = resolveAge(
    result.providerPublishedAt ?? null,
    fetchedAtIso,
  );
  const freshness = classifyFreshness({
    fetchedAtIso,
    nowIso: fetchedAtIso,
    status: result.status,
    rateLimited: result.rateLimited,
  });
  const confidence = classifyConfidence(
    availableMetrics(input.platform),
    result.metrics as Record<string, unknown>,
  );

  // Persist best-effort — a cache write failure must not surface as a
  // page error; the fetched result is still returned to the caller. The
  // persist layer never overwrites verified counts with empties.
  try {
    const { persistRefreshedMetrics } = await import(
      "@/repositories/post-metrics-repository"
    );
    await persistRefreshedMetrics({
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
      providerPublishedAt: result.providerPublishedAt ?? null,
      ageHours,
      ageWindow,
      freshness,
      confidence,
      providerPayloadVersion: `${result.source}:1`,
    });
  } catch (err) {
    console.error("[refresh-metrics] cache write failed (non-fatal)", err);
  }

  return result;
}
