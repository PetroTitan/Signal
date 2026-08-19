import "server-only";
/**
 * The canonical refresh-run record.
 *
 * One row per run, written unconditionally. Zero rows in this table means
 * the sweep has genuinely never run — which is a different statement from
 * "the sweep ran and found nothing", and before this table the two were
 * indistinguishable.
 *
 * Deliberately carries NO workspace, post or content identifier. A sweep
 * spans every workspace, so a run is not workspace-owned; per-workspace
 * detail stays in `activity_events`, which is RLS-scoped. `assertNoIds`
 * enforces that boundary at the write, not just in review.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MetricsRefreshRunInsert,
  MetricsRefreshRunRow,
} from "@/lib/supabase/types";
import type { SweepReport } from "@/core/metrics/refresh/sweep-report";
import { fromPostgres } from "./errors";

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * Map a report onto the run row. PURE and exported, so the shape is
 * testable without a database.
 *
 * Note what is NOT copied: `byWorkspace` (keyed by workspace id),
 * `failures` and `skips` (carry publish_history ids). Only counts and
 * provider names cross into this table.
 */
export function toRunInsert(report: SweepReport): MetricsRefreshRunInsert {
  const byProvider: Record<string, unknown> = {};
  for (const [platform, tally] of Object.entries(report.byPlatform)) {
    byProvider[platform] = {
      attempted: tally.attempted,
      connected: tally.connected,
      unavailable: tally.unavailable,
      unsupported: tally.unsupported,
      rateLimited: tally.rateLimited,
      failed: tally.failed,
      skipped: tally.skipped,
    };
  }

  return {
    run_id: report.runId,
    trigger: report.trigger,
    phase: report.phase,
    started_at: report.startedAt,
    finished_at: report.finishedAt,
    duration_ms: report.durationMs,
    workspace_count: Object.keys(report.byWorkspace).length,
    seed_window_days: report.seedWindowDays,
    publication_candidates: report.candidates,
    eligible_posts: Math.max(0, report.candidates - report.skipped),
    provider_reads_attempted: report.attempted,
    provider_reads_succeeded: report.succeeded,
    provider_reads_failed: report.failed,
    snapshots_written: report.snapshotsWritten,
    snapshots_skipped_duplicate: report.snapshotsSkippedDuplicate,
    rate_limited_count: report.rateLimited,
    unavailable_count: report.unavailable,
    unsupported_count: report.unsupported,
    stale_count: 0,
    provider_error_count: report.failed,
    skipped_count: report.skipped,
    account_snapshots_attempted: report.accountSnapshots.attempted,
    account_snapshots_written: report.accountSnapshots.written,
    account_snapshots_failed: report.accountSnapshots.failed,
    by_provider: byProvider,
    zero_reason: report.zeroReason,
    fatal_error: report.fatalError,
    diagnosis: report.diagnosis,
  };
}

/**
 * Refuse to write anything that looks like an identifier into a table
 * that is readable across workspaces. Returns the offending field so a
 * failure is actionable rather than mysterious.
 */
export function assertNoIds(insert: MetricsRefreshRunInsert): string | null {
  for (const [key, value] of Object.entries(insert)) {
    if (key === "run_id" || key === "id") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    if (UUID_RE.test(text)) return key;
  }
  return null;
}

export interface RecordRunResult {
  recorded: boolean;
  error: string | null;
}

/**
 * Write the run record. NEVER throws: losing the audit row must not lose
 * the measurements it describes, and a sweep that measured successfully
 * should not report failure because its diary entry did not save.
 */
export async function recordRefreshRun(
  db: SupabaseClient,
  report: SweepReport,
): Promise<RecordRunResult> {
  const insert = toRunInsert(report);

  const leaked = assertNoIds(insert);
  if (leaked) {
    console.error(
      `[refresh-run] refusing to write: field "${leaked}" contains an identifier`,
    );
    return { recorded: false, error: `identifier in field: ${leaked}` };
  }

  const { error } = await db
    .from("metrics_refresh_runs")
    .upsert(insert as never, { onConflict: "run_id" });
  if (error) {
    console.error("[refresh-run] write failed (non-fatal)", error.message);
    return { recorded: false, error: error.message };
  }
  return { recorded: true, error: null };
}

export interface RefreshRunSummary {
  runId: string;
  trigger: string;
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  candidates: number;
  attempted: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  snapshotsWritten: number;
  accountSnapshotsWritten: number;
  byProvider: Record<string, unknown>;
  zeroReason: string | null;
  diagnosis: string;
}

function toSummary(row: MetricsRefreshRunRow): RefreshRunSummary {
  return {
    runId: row.run_id,
    trigger: row.trigger,
    phase: row.phase,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    candidates: row.publication_candidates,
    attempted: row.provider_reads_attempted,
    succeeded: row.provider_reads_succeeded,
    failed: row.provider_reads_failed,
    rateLimited: row.rate_limited_count,
    snapshotsWritten: row.snapshots_written,
    accountSnapshotsWritten: row.account_snapshots_written,
    byProvider: row.by_provider,
    zeroReason: row.zero_reason,
    diagnosis: row.diagnosis,
  };
}

/**
 * X resources actually read since an instant, summed from run history.
 *
 * This is what makes the budget measured rather than assumed: every run
 * records its per-provider attempt count, so the day's spend is a fact
 * in the database rather than an estimate carried in memory.
 */
export async function sumXResourcesSince(
  db: SupabaseClient,
  sinceIso: string,
): Promise<number> {
  const { data, error } = await db
    .from("metrics_refresh_runs")
    .select("by_provider")
    .gte("started_at", sinceIso)
    .limit(500);
  if (error) throw fromPostgres(error, "Failed to sum X read usage.");

  let total = 0;
  for (const row of (data ?? []) as unknown as Array<{ by_provider: Record<string, unknown> }>) {
    const x = row.by_provider?.x as { attempted?: unknown } | undefined;
    if (x && typeof x.attempted === "number") total += x.attempted;
  }
  return total;
}

/** Most recent runs, newest first. */
export async function listRecentRefreshRuns(
  db: SupabaseClient,
  limit = 20,
): Promise<RefreshRunSummary[]> {
  const { data, error } = await db
    .from("metrics_refresh_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) throw fromPostgres(error, "Failed to list refresh runs.");
  return ((data ?? []) as unknown as MetricsRefreshRunRow[]).map(toSummary);
}

export interface RefreshRunHistory {
  /** Null when the sweep has never run at all. */
  lastRun: RefreshRunSummary | null;
  /** Last run that actually measured something. */
  lastSuccessfulRun: RefreshRunSummary | null;
  recent: RefreshRunSummary[];
  /** True when the table itself is unreachable (e.g. migration not applied). */
  unavailable: boolean;
  unavailableReason: string | null;
}

/**
 * Everything the health evaluator needs, in one read.
 *
 * A missing table is reported as `unavailable` rather than thrown: an
 * unapplied migration is a diagnosable configuration state, and surfacing
 * it as "schema missing" is far more useful than a 500.
 */
export async function loadRefreshRunHistory(
  db: SupabaseClient,
  limit = 20,
): Promise<RefreshRunHistory> {
  let recent: RefreshRunSummary[];
  try {
    recent = await listRecentRefreshRuns(db, limit);
  } catch (err) {
    return {
      lastRun: null,
      lastSuccessfulRun: null,
      recent: [],
      unavailable: true,
      unavailableReason:
        err instanceof Error ? err.message : "refresh run history unavailable",
    };
  }

  return {
    lastRun: recent[0] ?? null,
    lastSuccessfulRun:
      recent.find((r) => r.phase === "completed" && r.succeeded > 0) ?? null,
    recent,
    unavailable: false,
    unavailableReason: null,
  };
}
