import "server-only";
/**
 * Phase D.1 — assemble verified ResultDataPoints for a workspace.
 *
 * Shared by the Results page + the CSV export route so intelligence and
 * exports see the same data. Joins real publish_history rows to the
 * canonical post_metrics cache (snapshots excluded). Engagement is the
 * sum of verified counts when the metric is connected, else null — never
 * estimated. The metricsStatus falls back to the platform capability
 * ('pending' for verified-but-unfetched, 'unavailable'/'unsupported'
 * otherwise) exactly like the Results list.
 */

import { listPublishedForResults } from "@/repositories/publish-history-repository";
import { listPostMetricsForPublishHistory } from "@/repositories/post-metrics-repository";
import { hydrateExecutionItemDisplay } from "@/repositories/execution-item-repository";
import {
  engagementCount,
  metricCapability,
  type VerifiedMetrics,
} from "@/core/metrics/metrics-provider";
import type { PostMetricsStatus } from "@/lib/supabase/types";
import type { ResultDataPoint } from "./results-intelligence";

export async function loadResultPoints(
  workspaceId: string,
  opts: { sinceIso?: string | null; limit?: number } = {},
): Promise<ResultDataPoint[]> {
  const published = await listPublishedForResults(workspaceId, opts);
  if (published.length === 0) return [];

  const [metrics, display] = await Promise.all([
    listPostMetricsForPublishHistory(
      workspaceId,
      published.map((p) => p.id),
    ),
    hydrateExecutionItemDisplay(
      workspaceId,
      published.map((p) => p.executionItemId),
    ),
  ]);

  return published.map((p) => {
    const cached = metrics.get(p.id);
    let metricsStatus: PostMetricsStatus;
    let engagement: number | null = null;
    if (cached) {
      metricsStatus = cached.status;
      if (cached.status === "connected") {
        engagement = engagementCount(cached.metrics as VerifiedMetrics);
      }
    } else {
      const capability = metricCapability(p.platform);
      metricsStatus =
        capability === "verified"
          ? "pending"
          : capability === "unavailable"
            ? "unavailable"
            : "unsupported";
    }
    return {
      publishHistoryId: p.id,
      title: display.get(p.executionItemId)?.title ?? null,
      platform: p.platform,
      permalink: p.providerPermalink,
      publishedAtIso: p.finishedAt,
      engagement,
      metricsStatus,
    };
  });
}
