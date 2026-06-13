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
 * Per-platform capability (Phase D.1 audit). Only platforms whose
 * OFFICIAL API/endpoint returns real counts are 'verified':
 *   - bluesky: PUBLIC app-view getPosts → like/repost/reply/quote counts.
 *   - reddit:  PUBLIC permalink .json → score + num_comments.
 *   - devto:   PUBLIC articles/{id} → public reactions + comments.
 *   - x:        requires elevated/paid API tier → 'unavailable'.
 *   - hashnode: analytics live behind a GraphQL query not integrated yet
 *               → 'unavailable' (publishing IS supported).
 *   - linkedin: post analytics require approved Marketing API access
 *               → 'unavailable' (publishing IS supported).
 *   - telegram: Bot API exposes no post view/reaction counts →
 *               'unsupported'.
 *   - threads/instagram/youtube: no publisher + no metrics read →
 *               'unsupported'.
 *
 * 'verified' → real counts fetched & shown. 'unavailable' → the metric
 * could exist but the current integration/tier can't reach it; we show
 * "Unavailable", never an estimate. 'unsupported' → Signal does not read
 * metrics for this platform at all.
 */
export const PLATFORM_METRIC_CAPABILITY: Record<string, MetricCapability> = {
  bluesky: "verified",
  reddit: "verified",
  devto: "verified",
  x: "unavailable",
  hashnode: "unavailable",
  linkedin: "unavailable",
  telegram: "unsupported",
  threads: "unsupported",
  instagram: "unsupported",
  youtube: "unsupported",
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
    case "devto":
      return "devto_articles";
    case "x":
      return "x_api_v2";
    case "hashnode":
      return "hashnode_gql";
    case "linkedin":
      return "linkedin_api";
    default:
      return `${platform}_none`;
  }
}

/**
 * Honest, platform-specific explanation for an 'unavailable' capability.
 * Shown verbatim in the UI — never an estimate, just why the real metric
 * can't be read on the current integration.
 */
export function unavailableReason(platform: string): string {
  switch (platform) {
    case "x":
      return "X metrics require an elevated/paid API tier this account doesn't have.";
    case "hashnode":
      return "Hashnode analytics require a GraphQL query not yet integrated.";
    case "linkedin":
      return "LinkedIn post analytics require approved Marketing API access.";
    default:
      return "Metrics aren't reachable for this platform on the current integration.";
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
  /** dev.to public reaction count. */
  reactions?: number;
  /** Provider-reported view count (only when the API returns it). NOT
   *  counted as engagement. */
  views?: number;
}

/**
 * Engagement = the SUM of the verified interaction counts the provider
 * actually returned. This is an aggregate of real data, never an
 * invented "score": views are excluded (a view is not an interaction),
 * and a field absent from the provider response contributes nothing.
 */
export function engagementCount(metrics: VerifiedMetrics): number {
  return (
    (metrics.likes ?? 0) +
    (metrics.reposts ?? 0) +
    (metrics.replies ?? 0) +
    (metrics.quotes ?? 0) +
    (metrics.score ?? 0) +
    (metrics.comments ?? 0) +
    (metrics.reactions ?? 0)
  );
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
  if (m.reactions != null) parts.push(`${m.reactions} reactions`);
  if (m.comments != null) parts.push(`${m.comments} comments`);
  if (m.views != null) parts.push(`${m.views} views`);
  return parts.length > 0 ? parts.join(" · ") : "No metrics yet.";
}
