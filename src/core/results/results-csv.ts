/**
 * Phase D.1I — Results CSV exports (PURE).
 *
 * Serializes ONLY verified data the caller already assembled (top posts,
 * platform performance, metrics-history snapshots). No new computation,
 * no estimates — just RFC-4180 CSV. Empty inputs yield a header-only
 * file so a download is never a blank 200.
 */

import type { PlatformPerformance, TopPost } from "./results-intelligence";
import type { VerifiedMetrics } from "@/core/metrics/metrics-provider";

/** RFC-4180 cell: wrap in quotes when it contains a comma, quote, or newline. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // Trailing newline so concatenated/streamed files behave.
  return lines.join("\r\n") + "\r\n";
}

export function topPostsCsv(posts: TopPost[]): string {
  return toCsv(
    ["published_at", "platform", "title", "engagement", "permalink"],
    posts.map((p) => [
      p.publishedAtIso,
      p.platform,
      p.title ?? "",
      p.engagement,
      p.permalink ?? "",
    ]),
  );
}

export function platformPerformanceCsv(platforms: PlatformPerformance[]): string {
  return toCsv(
    ["platform", "measured_posts", "total_engagement", "avg_engagement"],
    platforms.map((p) => [
      p.platform,
      p.posts,
      p.totalEngagement,
      Math.round(p.avgEngagement * 100) / 100,
    ]),
  );
}

export interface MetricsHistoryCsvRow {
  publishHistoryId: string;
  platform: string;
  fetchedAt: string | null;
  status: string;
  metrics: VerifiedMetrics;
}

export function metricsHistoryCsv(rows: MetricsHistoryCsvRow[]): string {
  return toCsv(
    [
      "publish_history_id",
      "platform",
      "fetched_at",
      "status",
      "likes",
      "reposts",
      "replies",
      "quotes",
      "score",
      "reactions",
      "comments",
      "views",
    ],
    rows.map((r) => [
      r.publishHistoryId,
      r.platform,
      r.fetchedAt ?? "",
      r.status,
      r.metrics.likes ?? "",
      r.metrics.reposts ?? "",
      r.metrics.replies ?? "",
      r.metrics.quotes ?? "",
      r.metrics.score ?? "",
      r.metrics.reactions ?? "",
      r.metrics.comments ?? "",
      r.metrics.views ?? "",
    ]),
  );
}
