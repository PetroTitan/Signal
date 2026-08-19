/**
 * Per-METRIC availability, as distinct from per-PLATFORM capability.
 *
 * `PLATFORM_METRIC_CAPABILITY` answers "can we read anything at all for
 * this platform". That is too coarse for this milestone: X and Bluesky
 * are both `verified`, yet X reports impressions and Bluesky has no such
 * field anywhere in its 152-endpoint surface. A UI keyed only on
 * platform capability would have to render *something* for Bluesky
 * impressions, and the tempting something is `0`.
 *
 * So availability is modelled per (platform, metric), with three states
 * that mean genuinely different things:
 *
 *   available    the provider reports this metric and we read it
 *   unavailable  the metric could exist for this provider, but the
 *                current integration, tier or time window cannot reach it
 *   unsupported  the provider has no such concept — asking again, paying
 *                more, or reconnecting will never produce it
 *
 * Bluesky impressions are `unsupported`, and that is a permanent,
 * documented fact rather than a gap waiting to be filled. Pinning it
 * here (and testing it) is what stops a future contributor from
 * "fixing" an empty field with a zero.
 *
 * Pure module — no I/O.
 */

import type { VerifiedMetrics } from "./metrics-provider";

export type MetricKey = keyof VerifiedMetrics;

export type MetricAvailability = "available" | "unavailable" | "unsupported";

/** Every metric Signal knows how to talk about, in display order. */
export const METRIC_KEYS: MetricKey[] = [
  "impressions",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "bookmarks",
  "score",
  "comments",
  "reactions",
  "views",
];

export const METRIC_LABELS: Record<MetricKey, string> = {
  impressions: "Impressions",
  likes: "Likes",
  replies: "Replies",
  reposts: "Reposts",
  quotes: "Quotes",
  bookmarks: "Bookmarks",
  score: "Score",
  comments: "Comments",
  reactions: "Reactions",
  views: "Views",
};

/**
 * The availability matrix. Anything not listed for a platform is
 * `unsupported` — the safe default, because inventing availability is
 * worse than under-reporting it.
 *
 * X          public_metrics returns all six of its entries together.
 * Bluesky    the AppView returns exactly five counters. NO impressions,
 *            NO views, NO reach — verified against the official OpenAPI
 *            document and against a live read of real posts.
 * Reddit     public permalink .json → score + num_comments.
 * dev.to     public article → reactions + comments. page_views_count is
 *            author-only behind an API key, so views stay unavailable
 *            rather than unsupported: the metric exists, we can't reach it.
 */
const AVAILABILITY: Record<string, Partial<Record<MetricKey, MetricAvailability>>> = {
  x: {
    impressions: "available",
    likes: "available",
    replies: "available",
    reposts: "available",
    quotes: "available",
    bookmarks: "available",
  },
  bluesky: {
    likes: "available",
    replies: "available",
    reposts: "available",
    quotes: "available",
    bookmarks: "available",
    // impressions / views are deliberately ABSENT → unsupported.
  },
  reddit: {
    score: "available",
    comments: "available",
  },
  devto: {
    reactions: "available",
    comments: "available",
    views: "unavailable",
  },
};

export function metricAvailability(
  platform: string,
  metric: MetricKey,
): MetricAvailability {
  return AVAILABILITY[platform]?.[metric] ?? "unsupported";
}

/** The metrics a platform actually reports, in display order. */
export function availableMetrics(platform: string): MetricKey[] {
  return METRIC_KEYS.filter((m) => metricAvailability(platform, m) === "available");
}

/**
 * Does this platform report impressions at all?
 *
 * Exists as its own predicate because impressions are the metric the
 * operator most wants and the one Bluesky most definitively lacks, and
 * because a named function is harder to accidentally invert than a
 * string comparison buried in a component.
 */
export function supportsImpressions(platform: string): boolean {
  return metricAvailability(platform, "impressions") === "available";
}

export type MetricCellState =
  | { kind: "value"; value: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "not_measured"; reason: string };

/**
 * Resolve what to show for one metric on one post. This is the ONLY
 * function the UI should use to decide between a number and a phrase —
 * every caller going through it is what guarantees a missing metric can
 * never render as 0.
 *
 * Note the ordering: availability is consulted BEFORE the value. A
 * platform that does not support a metric reports `unsupported` even if
 * some stray key made it into the stored payload.
 */
export function resolveMetricCell(
  platform: string,
  metric: MetricKey,
  metrics: VerifiedMetrics | null | undefined,
): MetricCellState {
  const availability = metricAvailability(platform, metric);

  if (availability === "unsupported") {
    return {
      kind: "unsupported",
      reason: `${METRIC_LABELS[metric]} unavailable from ${platformLabel(platform)}`,
    };
  }
  if (availability === "unavailable") {
    return {
      kind: "unavailable",
      reason: `${METRIC_LABELS[metric]} not reachable on the current ${platformLabel(platform)} integration`,
    };
  }

  const value = metrics?.[metric];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      kind: "not_measured",
      reason: `${METRIC_LABELS[metric]} not measured yet`,
    };
  }
  return { kind: "value", value };
}

/** Display text for a cell — never a bare 0 for a missing metric. */
export function renderMetricCell(state: MetricCellState): string {
  return state.kind === "value" ? String(state.value) : state.reason;
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case "x":
      return "X";
    case "bluesky":
      return "Bluesky";
    case "devto":
      return "dev.to";
    case "reddit":
      return "Reddit";
    case "linkedin":
      return "LinkedIn";
    case "hashnode":
      return "Hashnode";
    case "telegram":
      return "Telegram";
    default:
      return platform;
  }
}
