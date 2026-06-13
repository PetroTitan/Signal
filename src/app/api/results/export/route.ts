import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAllMetricsRowsForWorkspace } from "@/repositories/post-metrics-repository";
import { loadResultPoints } from "@/core/results/load-result-points.server";
import {
  computeTopPosts,
  computeTopPlatforms,
  DEFAULT_THRESHOLDS,
} from "@/core/results/results-intelligence";
import {
  metricsHistoryCsv,
  platformPerformanceCsv,
  topPostsCsv,
  type MetricsHistoryCsvRow,
} from "@/core/results/results-csv";
import type { VerifiedMetrics } from "@/core/metrics/metrics-provider";

/**
 * Phase D.1I — verified Results CSV export.
 *
 * Session-gated (NOT in the middleware public list): the operator must
 * be signed in; data is scoped to their primary workspace via the
 * cookie-aware client. Exports ONLY verified data — top posts, platform
 * performance, and metrics-history snapshots. No estimates.
 *
 *   GET /api/results/export?type=top_posts|platform_performance|metrics_history
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ExportType = "top_posts" | "platform_performance" | "metrics_history";

function fileName(type: ExportType): string {
  return `signal-${type}.csv`;
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) {
    return new Response("Supabase not configured.", { status: 503 });
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return new Response("No workspace.", { status: 404 });
  }
  const workspaceId = membership.workspace.id;
  const type = (new URL(request.url).searchParams.get("type") ?? "top_posts") as ExportType;

  let csv: string;
  try {
    if (type === "metrics_history") {
      const rows = await listAllMetricsRowsForWorkspace(workspaceId);
      const csvRows: MetricsHistoryCsvRow[] = rows.map((r) => ({
        publishHistoryId: r.publishHistoryId,
        platform: r.platform,
        fetchedAt: r.fetchedAt,
        status: r.status,
        metrics: r.metrics as VerifiedMetrics,
      }));
      csv = metricsHistoryCsv(csvRows);
    } else {
      const points = await loadResultPoints(workspaceId, { limit: 1000 });
      if (type === "platform_performance") {
        // Threshold of 1 → export every platform with verified data.
        const res = computeTopPlatforms(points, {
          ...DEFAULT_THRESHOLDS,
          minConnectedPerPlatform: 1,
        });
        csv = platformPerformanceCsv(res.kind === "ok" ? res.platforms : []);
      } else {
        const res = computeTopPosts(points, {
          ...DEFAULT_THRESHOLDS,
          minConnectedForTopPosts: 1,
          topPostsLimit: 1000,
        });
        csv = topPostsCsv(res.kind === "ok" ? res.posts : []);
      }
    }
  } catch (err) {
    console.error("[results/export] failed", err);
    return new Response("Export failed.", { status: 500 });
  }

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName(type)}"`,
      "Cache-Control": "no-store",
    },
  });
}
