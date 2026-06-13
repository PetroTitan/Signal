import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type { PostMetricsInsert, PostMetricsRow } from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

/**
 * Phase C3.6 / D.1 — verified post-metrics cache. Stores ONLY provider-
 * verified counts. Reads are workspace-scoped via RLS.
 *
 * Row model (no schema change — `unique (publish_history_id, source)`):
 *   - The CANONICAL row per post uses the stable provider source
 *     (`metricSource(platform)`, e.g. "bluesky_getposts"). It always
 *     holds the LATEST verified state and is what the refresh sweep
 *     (`status='connected' AND next_refresh_at <= now`) + the Results
 *     list read.
 *   - HISTORY snapshots are additional immutable rows whose source is
 *     `snapshot:<provider_source>:<hour-bucket>`, written only when a
 *     fetch returns connected metrics. They carry `next_refresh_at =
 *     null` so the sweep never touches them, and are hour-bucketed so a
 *     re-run within the hour can't duplicate them.
 */

/** A row is a history snapshot (not the canonical latest) when its
 *  source carries the snapshot prefix. */
export const SNAPSHOT_SOURCE_PREFIX = "snapshot:";

export function snapshotSource(canonicalSource: string, fetchedAtIso: string): string {
  // Hour bucket → at most one snapshot per post per hour (idempotent).
  const hour = fetchedAtIso.slice(0, 13); // YYYY-MM-DDTHH
  return `${SNAPSHOT_SOURCE_PREFIX}${canonicalSource}:${hour}`;
}

export function isSnapshotSource(source: string): boolean {
  return source.startsWith(SNAPSHOT_SOURCE_PREFIX);
}

export interface PostMetricsRecord {
  publishHistoryId: string;
  platform: string;
  source: string;
  status: PostMetricsRow["status"];
  metrics: Record<string, unknown>;
  externalPostId: string | null;
  fetchedAt: string | null;
  nextRefreshAt: string | null;
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
    nextRefreshAt: row.next_refresh_at,
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
    // Only the CANONICAL row represents a post here — history snapshots
    // are skipped so a post never appears twice / as a snapshot.
    if (isSnapshotSource(row.source)) continue;
    if (!out.has(row.publish_history_id)) out.set(row.publish_history_id, toRecord(row));
  }
  return out;
}

/**
 * D.1I — every metrics row for a workspace (canonical + snapshots),
 * ordered for a stable history export. Bounded by `limit`.
 */
export async function listAllMetricsRowsForWorkspace(
  workspaceId: string,
  limit = 5000,
  db?: SupabaseClient,
): Promise<PostMetricsRecord[]> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("post_metrics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("publish_history_id", { ascending: true })
    .order("fetched_at", { ascending: true })
    .limit(Math.max(1, Math.min(10000, limit)));
  if (error) throw fromPostgres(error, "Failed to list workspace metrics.");
  return ((data ?? []) as unknown as PostMetricsRow[]).map(toRecord);
}

// =====================================================================
// D.1D — metrics history (latest snapshot + timeline + refresh status)
// =====================================================================

export interface MetricsHistory {
  publishHistoryId: string;
  /** The canonical latest row, or null if never fetched. */
  latest: PostMetricsRecord | null;
  /** Connected snapshots over time, oldest → newest (real points only). */
  snapshots: PostMetricsRecord[];
  refreshStatus: PostMetricsRow["status"] | "pending";
  nextRefreshAt: string | null;
}

export async function listMetricsHistory(
  workspaceId: string,
  publishHistoryId: string,
  db?: SupabaseClient,
): Promise<MetricsHistory> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("post_metrics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("publish_history_id", publishHistoryId)
    .order("fetched_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to read metrics history.");
  const rows = ((data ?? []) as unknown as PostMetricsRow[]).map(toRecord);
  const latest = rows.find((r) => !isSnapshotSource(r.source)) ?? null;
  const snapshots = rows
    .filter((r) => isSnapshotSource(r.source))
    .sort((a, b) => (a.fetchedAt ?? "").localeCompare(b.fetchedAt ?? ""));
  return {
    publishHistoryId,
    latest,
    snapshots,
    refreshStatus: latest?.status ?? "pending",
    nextRefreshAt: latest?.nextRefreshAt ?? null,
  };
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

// =====================================================================
// D.1B — refresh persistence (never overwrite real data with empties)
// =====================================================================

export interface RefreshWritePlan {
  status: PostMetricsRow["status"];
  metrics: Record<string, unknown>;
  /** True when we kept prior verified data rather than clobbering it. */
  preserved: boolean;
  /** True → keep the existing fetched_at (preserve case). */
  keepFetchedAt: boolean;
  /** True → write a connected history snapshot. */
  snapshot: boolean;
}

/**
 * PURE decision for how a refresh result should be written, enforcing
 * the no-clobber rule: a non-connected fetch never overwrites prior
 * verified connected metrics. Exported for direct testing.
 */
export function planRefreshWrite(
  existing: { status: PostMetricsRow["status"]; metrics: Record<string, unknown> } | null,
  incoming: { status: PostMetricsRow["status"]; metrics: Record<string, unknown> },
): RefreshWritePlan {
  if (incoming.status === "connected") {
    return {
      status: "connected",
      metrics: incoming.metrics,
      preserved: false,
      keepFetchedAt: false,
      snapshot: true,
    };
  }
  const hadConnected =
    existing?.status === "connected" &&
    existing.metrics != null &&
    Object.keys(existing.metrics).length > 0;
  if (hadConnected) {
    return {
      status: "connected",
      metrics: existing!.metrics,
      preserved: true,
      keepFetchedAt: true,
      snapshot: false,
    };
  }
  return {
    status: incoming.status,
    metrics: {},
    preserved: false,
    keepFetchedAt: false,
    snapshot: false,
  };
}

export interface PersistRefreshInput {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  /** Canonical provider source for this platform. */
  source: string;
  externalPostId: string | null;
  status: PostMetricsRow["status"];
  metrics: Record<string, unknown>;
  error: string | null;
  /** next_refresh_at to set when the row is/stays connected. */
  nextRefreshAt: string | null;
  nowIso?: string;
  db?: SupabaseClient;
}

/**
 * Persist a refreshed metric result onto the CANONICAL row, with a hard
 * rule: a non-connected fetch (unavailable/unsupported/pending) NEVER
 * clobbers previously-verified connected metrics. In that case we keep
 * the last-good status + counts + fetched_at and only record the new
 * `error` (and bump next_refresh_at so it retries). A connected fetch
 * updates the counts and writes an hour-bucketed history snapshot.
 *
 * Returns whether a connected snapshot was written (for the engine
 * summary). Idempotent: the snapshot upsert ignores duplicates.
 */
export async function persistRefreshedMetrics(
  input: PersistRefreshInput,
): Promise<{ snapshotWritten: boolean; preserved: boolean }> {
  const supabase = input.db ?? createSupabaseServerClient();
  const nowIso = input.nowIso ?? new Date().toISOString();

  const { data: existingData, error: readErr } = await supabase
    .from("post_metrics")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("publish_history_id", input.publishHistoryId)
    .eq("source", input.source)
    .maybeSingle();
  if (readErr) throw fromPostgres(readErr, "Failed to read post metrics.");
  const existing = existingData
    ? toRecord(existingData as unknown as PostMetricsRow)
    : null;

  const plan = planRefreshWrite(
    existing ? { status: existing.status, metrics: existing.metrics } : null,
    { status: input.status, metrics: input.metrics },
  );

  // Non-connected outcomes don't get a forward next_refresh_at unless
  // they preserved connected data (then retry later); fresh non-connected
  // rows aren't auto-swept.
  const nextRefreshAt =
    plan.status === "connected" ? input.nextRefreshAt : null;
  const writeRow: PostMetricsInsert = {
    workspace_id: input.workspaceId,
    publish_history_id: input.publishHistoryId,
    platform: input.platform,
    source: input.source,
    external_post_id: plan.preserved
      ? existing?.externalPostId ?? input.externalPostId
      : input.externalPostId,
    status: plan.status,
    metrics: plan.metrics,
    fetched_at: plan.keepFetchedAt ? existing?.fetchedAt ?? nowIso : nowIso,
    next_refresh_at: nextRefreshAt,
    error: input.status === "connected" ? null : input.error,
  };
  const preserved = plan.preserved;

  const { error: writeErr } = await supabase
    .from("post_metrics")
    .upsert(writeRow as never, { onConflict: "publish_history_id,source" });
  if (writeErr) throw fromPostgres(writeErr, "Failed to persist post metrics.");

  // History snapshot — only for genuinely connected results (real points).
  let snapshotWritten = false;
  if (plan.snapshot) {
    const snapRow: PostMetricsInsert = {
      workspace_id: input.workspaceId,
      publish_history_id: input.publishHistoryId,
      platform: input.platform,
      source: snapshotSource(input.source, nowIso),
      external_post_id: input.externalPostId,
      status: "connected",
      metrics: input.metrics,
      fetched_at: nowIso,
      next_refresh_at: null, // snapshots are immutable — never swept
      error: null,
    };
    const { error: snapErr } = await supabase
      .from("post_metrics")
      .upsert(snapRow as never, {
        onConflict: "publish_history_id,source",
        ignoreDuplicates: true,
      });
    if (snapErr) throw fromPostgres(snapErr, "Failed to write metrics snapshot.");
    snapshotWritten = true;
  }

  return { snapshotWritten, preserved };
}

// =====================================================================
// D.1B — refresh sweep loaders (cron runs as the system: service-role)
// =====================================================================

export interface RefreshTarget {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  externalPostId: string | null;
  permalink: string | null;
}

/**
 * Canonical connected rows due for refresh (next_refresh_at <= now).
 * Embeds publish_history to recover the permalink (Reddit) + provider
 * post id. Snapshot rows are excluded (they have next_refresh_at null).
 */
export async function listStaleConnectedMetrics(
  db: SupabaseClient,
  nowIso: string,
  limit = 100,
): Promise<RefreshTarget[]> {
  const { data, error } = await db
    .from("post_metrics")
    .select(
      "workspace_id, publish_history_id, platform, external_post_id, next_refresh_at, status, publish_history(provider_permalink, provider_post_id)",
    )
    .eq("status", "connected")
    .lte("next_refresh_at", nowIso)
    .order("next_refresh_at", { ascending: true })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to load stale metrics.");
  return ((data ?? []) as unknown as Array<{
    workspace_id: string;
    publish_history_id: string;
    platform: string;
    external_post_id: string | null;
    publish_history:
      | { provider_permalink: string | null; provider_post_id: string | null }
      | { provider_permalink: string | null; provider_post_id: string | null }[]
      | null;
  }>).map((row) => {
    const ph = Array.isArray(row.publish_history) ? row.publish_history[0] : row.publish_history;
    return {
      workspaceId: row.workspace_id,
      publishHistoryId: row.publish_history_id,
      platform: row.platform,
      externalPostId: row.external_post_id ?? ph?.provider_post_id ?? null,
      permalink: ph?.provider_permalink ?? null,
    };
  });
}

/**
 * Recently-published posts on verified platforms that have NO canonical
 * metrics row yet — so the daily sweep can seed their first fetch.
 */
export async function listUnmeasuredPublishedPosts(
  db: SupabaseClient,
  verifiedPlatforms: string[],
  sinceIso: string,
  limit = 100,
): Promise<RefreshTarget[]> {
  if (verifiedPlatforms.length === 0) return [];
  const { data, error } = await db
    .from("publish_history")
    .select("id, workspace_id, platform, provider_post_id, provider_permalink, finished_at")
    .eq("outcome", "published")
    .in("platform", verifiedPlatforms)
    .gte("finished_at", sinceIso)
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to load published posts.");
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    workspace_id: string;
    platform: string;
    provider_post_id: string | null;
    provider_permalink: string | null;
  }>;
  if (rows.length === 0) return [];

  // Which of these already have a canonical metrics row?
  const { data: existing, error: exErr } = await db
    .from("post_metrics")
    .select("publish_history_id, source")
    .in(
      "publish_history_id",
      rows.map((r) => r.id),
    );
  if (exErr) throw fromPostgres(exErr, "Failed to check existing metrics.");
  const measured = new Set(
    ((existing ?? []) as Array<{ publish_history_id: string; source: string }>)
      .filter((e) => !isSnapshotSource(e.source))
      .map((e) => e.publish_history_id),
  );

  return rows
    .filter((r) => !measured.has(r.id))
    .map((r) => ({
      workspaceId: r.workspace_id,
      publishHistoryId: r.id,
      platform: r.platform,
      externalPostId: r.provider_post_id,
      permalink: r.provider_permalink,
    }));
}
