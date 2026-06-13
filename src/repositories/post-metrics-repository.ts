import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type { PostMetricsInsert, PostMetricsRow } from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

/**
 * Phase C3.6 — verified post-metrics cache. Stores ONLY provider-
 * verified counts. Upsert is keyed on (publish_history_id, source) so a
 * refresh updates in place (no duplicate rows). Reads are workspace-
 * scoped via RLS.
 */

export interface PostMetricsRecord {
  publishHistoryId: string;
  platform: string;
  source: string;
  status: PostMetricsRow["status"];
  metrics: Record<string, unknown>;
  externalPostId: string | null;
  fetchedAt: string | null;
  error: string | null;
}

function toRecord(row: PostMetricsRow): PostMetricsRecord {
  return {
    publishHistoryId: row.publish_history_id,
    platform: row.platform,
    source: row.source,
    status: row.status,
    metrics: row.metrics,
    externalPostId: row.external_post_id,
    fetchedAt: row.fetched_at,
    error: row.error,
  };
}

export async function listPostMetricsForPublishHistory(
  workspaceId: string,
  publishHistoryIds: string[],
  db?: SupabaseClient,
): Promise<Map<string, PostMetricsRecord>> {
  const out = new Map<string, PostMetricsRecord>();
  const ids = Array.from(new Set(publishHistoryIds)).filter(Boolean);
  if (ids.length === 0) return out;
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("post_metrics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("publish_history_id", ids);
  if (error) throw fromPostgres(error, "Failed to read post metrics.");
  for (const row of (data ?? []) as unknown as PostMetricsRow[]) {
    // One row per (publish_history_id, source); keep the first / latest.
    if (!out.has(row.publish_history_id)) out.set(row.publish_history_id, toRecord(row));
  }
  return out;
}

export async function upsertPostMetrics(input: {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  source: string;
  externalPostId: string | null;
  status: PostMetricsRow["status"];
  metrics: Record<string, unknown>;
  error: string | null;
  nextRefreshAt: string | null;
  db?: SupabaseClient;
}): Promise<void> {
  const supabase = input.db ?? createSupabaseServerClient();
  const row: PostMetricsInsert = {
    workspace_id: input.workspaceId,
    publish_history_id: input.publishHistoryId,
    platform: input.platform,
    source: input.source,
    external_post_id: input.externalPostId,
    status: input.status,
    metrics: input.metrics,
    fetched_at: new Date().toISOString(),
    next_refresh_at: input.nextRefreshAt,
    error: input.error,
  };
  const { error } = await supabase
    .from("post_metrics")
    .upsert(row as never, { onConflict: "publish_history_id,source" });
  if (error) throw fromPostgres(error, "Failed to upsert post metrics.");
}
