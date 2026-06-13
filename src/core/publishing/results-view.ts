/**
 * Phase B5 — Results Loop assembly (pure).
 *
 * Turns a published `publish_history` row + its execution-item context
 * + its execution_logs into the operator-facing "Result" record: what
 * went out, where, under which identity, how it behaved (retry history,
 * outcome, publish duration), and a deliberately-empty metrics slot.
 *
 * Source of truth ONLY: publish_history, execution_items,
 * execution_logs, operator-entered notes, platform permalinks. No
 * estimated engagement, no invented reach. The `metrics` field is an
 * EXTENSION POINT: when a verified provider metrics source is wired,
 * it populates `metrics`; until then `metricsStatus = "not_connected"`
 * and the UI shows "Metrics not yet connected." Nothing is faked.
 *
 * Pure module — no I/O. The repository/page loads the rows and passes
 * plain shapes in.
 */

export interface ResultLogEntry {
  eventType: string;
  severity: string;
  message: string;
  createdAtIso: string;
}

export interface ResultSourceRow {
  /** publish_history.id */
  id: string;
  executionItemId: string;
  platform: string;
  subreddit: string | null;
  outcome: "published" | "failed" | "blocked";
  permalink: string | null;
  providerPostId: string | null;
  startedAtIso: string;
  finishedAtIso: string;
  /** publish mode: "api" | "manual". */
  mode: string;
  reasonCode: string | null;
}

export interface ResultContext {
  /** Resolved post title (from the execution/plan item). */
  title: string | null;
  /** Account/identity display (handle or name), if resolvable. */
  identityLabel: string | null;
  /** Operator notes carried on the plan item metadata, if any. */
  operatorNotes: string | null;
  /** execution_items.attempt_count, when known. */
  attemptCount: number | null;
  /** Ordered execution logs for this item (oldest → newest). */
  logs: ResultLogEntry[];
}

export type MetricsStatus = "not_connected" | "connected";

export interface ProviderMetrics {
  /** Real, provider-verified counts only. All optional. */
  impressions?: number | null;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  /** When the metrics were fetched from the provider (ISO). */
  fetchedAtIso?: string | null;
  /** Provider/source label, e.g. "x_api_v2". */
  source?: string | null;
}

export interface ResultRecord {
  id: string;
  executionItemId: string;
  detailHref: string;
  title: string | null;
  platform: string;
  subreddit: string | null;
  outcome: "published" | "failed" | "blocked";
  permalink: string | null;
  publishedAtIso: string;
  identityLabel: string | null;
  operatorNotes: string | null;
  mode: string;
  /** Wall-clock publish duration in ms (finished − started), or null. */
  publishDurationMs: number | null;
  attemptCount: number | null;
  /** Whether this item was retried (attempt_count > 1 OR retry logs). */
  retried: boolean;
  retryEvents: ResultLogEntry[];
  metricsStatus: MetricsStatus;
  metrics: ProviderMetrics | null;
}

const RETRY_EVENT_TYPES = new Set(["item.failed", "item.queued"]);

/**
 * Assemble a single Result record. `metrics` is passed through only
 * when a verified provider source supplied it; otherwise the record is
 * marked `not_connected` and the UI shows the honest empty state.
 */
export function assembleResult(input: {
  row: ResultSourceRow;
  context: ResultContext;
  metrics?: ProviderMetrics | null;
}): ResultRecord {
  const { row, context } = input;

  const started = new Date(row.startedAtIso).getTime();
  const finished = new Date(row.finishedAtIso).getTime();
  const publishDurationMs =
    Number.isFinite(started) && Number.isFinite(finished) && finished >= started
      ? finished - started
      : null;

  const retryEvents = context.logs.filter((l) =>
    RETRY_EVENT_TYPES.has(l.eventType),
  );
  const retried =
    (context.attemptCount ?? 0) > 1 || retryEvents.length > 1;

  const metrics = input.metrics ?? null;

  return {
    id: row.id,
    executionItemId: row.executionItemId,
    detailHref: `/execution/items/${row.executionItemId}`,
    title: context.title,
    platform: row.platform,
    subreddit: row.subreddit,
    outcome: row.outcome,
    permalink: row.permalink,
    publishedAtIso: row.finishedAtIso,
    identityLabel: context.identityLabel,
    operatorNotes: context.operatorNotes,
    mode: row.mode,
    publishDurationMs,
    attemptCount: context.attemptCount,
    retried,
    retryEvents,
    metricsStatus: metrics ? "connected" : "not_connected",
    metrics,
  };
}

/** Human "1.2s" / "830ms" / "—" for a publish duration. */
export function formatPublishDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
