/**
 * Phase C3.1 — provider-aware metrics layer (pure).
 *
 * The single source of truth for "can we show verified metrics for this
 * platform, and in what shape?". Server fetchers + the Results UI both
 * key off this so capability + states never drift.
 *
 * HARD RULE: only provider-verified counts are ever surfaced. There are
 * NO estimates, no reach, no engagement/viral scores, no derived
 * analytics. Where a platform's API isn't reachable on the current tier
 * we return `unavailable`; where Signal doesn't read metrics for a
 * platform we return `unsupported`. Nothing is fabricated.
 *
 * Pure module — no I/O.
 */

import type { PostMetricsStatus } from "@/lib/supabase/types";

export type MetricCapability = "verified" | "unavailable" | "unsupported";

/**
 * Per-platform capability:
 *   - bluesky: PUBLIC app-view getPosts → like/repost/reply/quote counts.
 *   - reddit:  PUBLIC permalink .json → score + num_comments.
 *   - x:       requires elevated/paid API tier → 'unavailable'.
 *   - everything else: not read by Signal → 'unsupported'.
 */
export const PLATFORM_METRIC_CAPABILITY: Record<string, MetricCapability> = {
  bluesky: "verified",
  reddit: "verified",
  x: "unavailable",
  linkedin: "unsupported",
  threads: "unsupported",
  instagram: "unsupported",
  youtube: "unsupported",
  telegram: "unsupported",
  devto: "unsupported",
  hashnode: "unsupported",
};

export function metricCapability(platform: string): MetricCapability {
  return PLATFORM_METRIC_CAPABILITY[platform] ?? "unsupported";
}

/** The metric source label persisted on post_metrics.source. */
export function metricSource(platform: string): string {
  switch (platform) {
    case "bluesky":
      return "bluesky_getposts";
    case "reddit":
      return "reddit_info";
    case "x":
      return "x_api_v2";
    default:
      return `${platform}_none`;
  }
}

/**
 * Normalized, verified metric counts. Every field is OPTIONAL and only
 * present when the provider returned it. snake_case to match the JSONB
 * persisted in post_metrics.metrics.
 */
export interface VerifiedMetrics {
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  score?: number;
  comments?: number;
}

export interface MetricsResult {
  status: PostMetricsStatus;
  source: string;
  externalPostId: string | null;
  metrics: VerifiedMetrics;
  error?: string | null;
}

/** A non-fetchable result for a platform we don't read. */
export function unsupportedResult(platform: string): MetricsResult {
  return {
    status: "unsupported",
    source: metricSource(platform),
    externalPostId: null,
    metrics: {},
  };
}

/** A tier-gated / not-reachable result (e.g. X without elevated access). */
export function unavailableResult(
  platform: string,
  externalPostId: string | null,
  error?: string,
): MetricsResult {
  return {
    status: "unavailable",
    source: metricSource(platform),
    externalPostId,
    metrics: {},
    error: error ?? null,
  };
}

/** Coerce an unknown numeric field to a non-negative integer or omit it. */
export function coerceCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

/** Human one-liner for the Results UI. */
export function describeMetrics(result: {
  status: PostMetricsStatus;
  metrics: VerifiedMetrics;
}): string {
  if (result.status === "unsupported") return "Metrics not supported for this platform.";
  if (result.status === "unavailable") return "Metrics unavailable for this account.";
  if (result.status === "pending") return "Metrics not connected.";
  const parts: string[] = [];
  const m = result.metrics;
  if (m.likes != null) parts.push(`${m.likes} likes`);
  if (m.reposts != null) parts.push(`${m.reposts} reposts`);
  if (m.replies != null) parts.push(`${m.replies} replies`);
  if (m.quotes != null) parts.push(`${m.quotes} quotes`);
  if (m.score != null) parts.push(`score ${m.score}`);
  if (m.comments != null) parts.push(`${m.comments} comments`);
  return parts.length > 0 ? parts.join(" · ") : "No metrics yet.";
}
