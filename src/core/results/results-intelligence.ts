/**
 * Phase D.1E — Results Intelligence (PURE).
 *
 * Turns verified, source-of-truth data into operator insight. Hard rule:
 * every number here is derived ONLY from (a) real publish_history
 * timestamps and (b) verified provider metric counts already stored in
 * post_metrics. There are NO estimates, NO inferred reach/impressions,
 * NO AI summaries, NO synthetic trends. "Engagement" is strictly the sum
 * of verified interaction counts the provider returned.
 *
 * When the sample is too small to be meaningful, a calculation returns
 * `insufficient_data` (with how many points are needed vs. present)
 * rather than a misleading number. Thresholds are configurable + below.
 *
 * No I/O — the repository/UI feeds real rows in; this module only maths.
 */

import type { PostMetricsStatus } from "@/lib/supabase/types";

/** One published post + (optionally) its latest verified engagement. */
export interface ResultDataPoint {
  publishHistoryId: string;
  title: string | null;
  platform: string;
  permalink: string | null;
  /** publish_history.finished_at (ISO). Real timestamp. */
  publishedAtIso: string;
  /** Sum of verified provider counts, or null when not connected. */
  engagement: number | null;
  metricsStatus: PostMetricsStatus;
}

export interface IntelligenceThresholds {
  /** Min connected posts before Top Posts is shown. */
  minConnectedForTopPosts: number;
  /** Min connected posts on a platform before it ranks. */
  minConnectedPerPlatform: number;
  /** Min published posts before Consistency is shown. */
  minPostsForConsistency: number;
  /** Min connected posts before Best Time is shown. */
  minConnectedForBestTime: number;
  /** How many Top Posts to return. */
  topPostsLimit: number;
}

/**
 * Documented defaults. Deliberately conservative: with only one or two
 * measured posts, "top post" / "best time" would be noise, so we hold
 * back until there's enough verified signal.
 */
export const DEFAULT_THRESHOLDS: IntelligenceThresholds = {
  minConnectedForTopPosts: 3,
  minConnectedPerPlatform: 3,
  minPostsForConsistency: 3,
  minConnectedForBestTime: 5,
  topPostsLimit: 5,
};

export interface InsufficientData {
  kind: "insufficient_data";
  needed: number;
  have: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function connectedPoints(points: ResultDataPoint[]): ResultDataPoint[] {
  return points.filter(
    (p) => p.metricsStatus === "connected" && typeof p.engagement === "number",
  );
}

function validPublished(points: ResultDataPoint[]): ResultDataPoint[] {
  return points.filter((p) => !Number.isNaN(new Date(p.publishedAtIso).getTime()));
}

// ---------------------------------------------------------------------
// Top Posts
// ---------------------------------------------------------------------

export interface TopPost {
  publishHistoryId: string;
  title: string | null;
  platform: string;
  permalink: string | null;
  engagement: number;
  publishedAtIso: string;
}

export type TopPostsResult = InsufficientData | { kind: "ok"; posts: TopPost[] };

export function computeTopPosts(
  points: ResultDataPoint[],
  thresholds: IntelligenceThresholds = DEFAULT_THRESHOLDS,
): TopPostsResult {
  const connected = connectedPoints(points);
  if (connected.length < thresholds.minConnectedForTopPosts) {
    return {
      kind: "insufficient_data",
      needed: thresholds.minConnectedForTopPosts,
      have: connected.length,
    };
  }
  const posts = connected
    .map((p) => ({
      publishHistoryId: p.publishHistoryId,
      title: p.title,
      platform: p.platform,
      permalink: p.permalink,
      engagement: p.engagement as number,
      publishedAtIso: p.publishedAtIso,
    }))
    // Deterministic: engagement desc, then most recent, then id.
    .sort(
      (a, b) =>
        b.engagement - a.engagement ||
        b.publishedAtIso.localeCompare(a.publishedAtIso) ||
        a.publishHistoryId.localeCompare(b.publishHistoryId),
    )
    .slice(0, Math.max(1, thresholds.topPostsLimit));
  return { kind: "ok", posts };
}

// ---------------------------------------------------------------------
// Top Platforms (by average verified engagement)
// ---------------------------------------------------------------------

export interface PlatformPerformance {
  platform: string;
  posts: number;
  totalEngagement: number;
  avgEngagement: number;
}

export type TopPlatformsResult =
  | InsufficientData
  | { kind: "ok"; platforms: PlatformPerformance[] };

export function computeTopPlatforms(
  points: ResultDataPoint[],
  thresholds: IntelligenceThresholds = DEFAULT_THRESHOLDS,
): TopPlatformsResult {
  const connected = connectedPoints(points);
  const groups = new Map<string, number[]>();
  for (const p of connected) {
    const arr = groups.get(p.platform) ?? [];
    arr.push(p.engagement as number);
    groups.set(p.platform, arr);
  }
  const platforms: PlatformPerformance[] = [];
  for (const [platform, values] of groups) {
    if (values.length < thresholds.minConnectedPerPlatform) continue;
    const total = values.reduce((s, v) => s + v, 0);
    platforms.push({
      platform,
      posts: values.length,
      totalEngagement: total,
      avgEngagement: total / values.length,
    });
  }
  if (platforms.length === 0) {
    return {
      kind: "insufficient_data",
      needed: thresholds.minConnectedPerPlatform,
      have: connected.length,
    };
  }
  platforms.sort(
    (a, b) => b.avgEngagement - a.avgEngagement || a.platform.localeCompare(b.platform),
  );
  return { kind: "ok", platforms };
}

// ---------------------------------------------------------------------
// Publishing Consistency (from real timestamps only)
// ---------------------------------------------------------------------

export interface ConsistencyStats {
  totalPosts: number;
  firstIso: string;
  lastIso: string;
  spanDays: number;
  activeDays: number;
  postsPerWeek: number;
  longestGapDays: number;
}

export type ConsistencyResult = InsufficientData | { kind: "ok"; stats: ConsistencyStats };

export function computePublishingConsistency(
  points: ResultDataPoint[],
  thresholds: IntelligenceThresholds = DEFAULT_THRESHOLDS,
): ConsistencyResult {
  const valid = validPublished(points);
  if (valid.length < thresholds.minPostsForConsistency) {
    return {
      kind: "insufficient_data",
      needed: thresholds.minPostsForConsistency,
      have: valid.length,
    };
  }
  const times = valid
    .map((p) => new Date(p.publishedAtIso).getTime())
    .sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  const spanDays = Math.max(0, (last - first) / DAY_MS);

  const dayKeys = new Set(
    times.map((t) => new Date(t).toISOString().slice(0, 10)),
  );
  let longestGapMs = 0;
  for (let i = 1; i < times.length; i += 1) {
    longestGapMs = Math.max(longestGapMs, times[i] - times[i - 1]);
  }
  // Per-week rate over the active span (≥1 week to avoid div-by-zero spikes).
  const weeks = Math.max(spanDays / 7, 1 / 7);
  return {
    kind: "ok",
    stats: {
      totalPosts: valid.length,
      firstIso: new Date(first).toISOString(),
      lastIso: new Date(last).toISOString(),
      spanDays: Math.round(spanDays * 10) / 10,
      activeDays: dayKeys.size,
      postsPerWeek: Math.round((valid.length / weeks) * 10) / 10,
      longestGapDays: Math.round((longestGapMs / DAY_MS) * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------
// Best Publishing Time (by verified engagement, UTC buckets)
// ---------------------------------------------------------------------

export interface TimeBucket {
  /** 0–23 (UTC hour) or 0–6 (UTC weekday). */
  bucket: number;
  label: string;
  posts: number;
  avgEngagement: number;
}

export interface BestTimeStats {
  /** UTC is used for deterministic bucketing; documented in the UI. */
  timezone: "UTC";
  byHour: TimeBucket[];
  byWeekday: TimeBucket[];
  bestHour: TimeBucket | null;
  bestWeekday: TimeBucket | null;
  sampleSize: number;
}

export type BestTimeResult = InsufficientData | { kind: "ok"; stats: BestTimeStats };

function summarizeBuckets(
  groups: Map<number, number[]>,
  label: (bucket: number) => string,
): TimeBucket[] {
  const out: TimeBucket[] = [];
  for (const [bucket, values] of groups) {
    const total = values.reduce((s, v) => s + v, 0);
    out.push({
      bucket,
      label: label(bucket),
      posts: values.length,
      avgEngagement: total / values.length,
    });
  }
  return out.sort((a, b) => a.bucket - b.bucket);
}

function pickBest(buckets: TimeBucket[]): TimeBucket | null {
  if (buckets.length === 0) return null;
  return [...buckets].sort(
    (a, b) => b.avgEngagement - a.avgEngagement || a.bucket - b.bucket,
  )[0];
}

export function computeBestPublishingTime(
  points: ResultDataPoint[],
  thresholds: IntelligenceThresholds = DEFAULT_THRESHOLDS,
): BestTimeResult {
  const connected = connectedPoints(points).filter(
    (p) => !Number.isNaN(new Date(p.publishedAtIso).getTime()),
  );
  if (connected.length < thresholds.minConnectedForBestTime) {
    return {
      kind: "insufficient_data",
      needed: thresholds.minConnectedForBestTime,
      have: connected.length,
    };
  }
  const hourGroups = new Map<number, number[]>();
  const weekdayGroups = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number) => {
    const arr = m.get(k) ?? [];
    arr.push(v);
    m.set(k, arr);
  };
  for (const p of connected) {
    const d = new Date(p.publishedAtIso);
    const e = p.engagement as number;
    push(hourGroups, d.getUTCHours(), e);
    push(weekdayGroups, d.getUTCDay(), e);
  }
  const byHour = summarizeBuckets(hourGroups, (h) => `${String(h).padStart(2, "0")}:00 UTC`);
  const byWeekday = summarizeBuckets(weekdayGroups, (w) => WEEKDAY_LABELS[w] ?? String(w));
  return {
    kind: "ok",
    stats: {
      timezone: "UTC",
      byHour,
      byWeekday,
      bestHour: pickBest(byHour),
      bestWeekday: pickBest(byWeekday),
      sampleSize: connected.length,
    },
  };
}

// ---------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------

export interface ResultsIntelligence {
  topPosts: TopPostsResult;
  topPlatforms: TopPlatformsResult;
  consistency: ConsistencyResult;
  bestTime: BestTimeResult;
  /** Counts for the UI ("12 posts · 5 measured"). */
  totalPosts: number;
  connectedPosts: number;
}

export function computeResultsIntelligence(
  points: ResultDataPoint[],
  thresholds: IntelligenceThresholds = DEFAULT_THRESHOLDS,
): ResultsIntelligence {
  return {
    topPosts: computeTopPosts(points, thresholds),
    topPlatforms: computeTopPlatforms(points, thresholds),
    consistency: computePublishingConsistency(points, thresholds),
    bestTime: computeBestPublishingTime(points, thresholds),
    totalPosts: validPublished(points).length,
    connectedPosts: connectedPoints(points).length,
  };
}
