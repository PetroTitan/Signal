import "server-only";
/**
 * Persist a sweep report to the existing audit trail.
 *
 * Deliberately reuses `activity_events` rather than adding a table: it
 * is already the workspace-scoped operational record, it is already
 * rendered by /activity, and it already has RLS. One row per workspace
 * the sweep touched, plus — critically — one row per workspace when the
 * sweep found NOTHING, because "nothing happened" is exactly the outcome
 * that needs explaining.
 *
 * The zero-candidate case has no workspace to attribute to (the loaders
 * return no rows, so no workspace id is known). Rather than invent one,
 * that case is reported through the route's JSON response and the
 * stdout log line only. `resolveReportWorkspaces` makes that boundary
 * explicit instead of leaving it as a silent gap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordSystemActivity } from "@/repositories/activity-repository";
import type { SweepReport } from "./sweep-report";

export const SWEEP_EVENT_TYPE = "metrics.sweep_completed";
export const SWEEP_FAILED_EVENT_TYPE = "metrics.sweep_failed";

/** Workspaces this report can be attributed to, sorted for determinism. */
export function resolveReportWorkspaces(report: SweepReport): string[] {
  return Object.keys(report.byWorkspace).sort();
}

/**
 * The per-workspace slice of the run. Cross-workspace totals are kept
 * too — an operator reading one workspace's timeline still needs to know
 * whether a loader failed globally.
 */
export function workspaceSummary(report: SweepReport, workspaceId: string) {
  const ws = report.byWorkspace[workspaceId];
  return {
    version: report.version,
    runId: report.runId,
    phase: report.phase,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    seedWindowDays: report.seedWindowDays,
    workspace: ws ?? null,
    loaders: report.loaders,
    totals: {
      candidates: report.candidates,
      attempted: report.attempted,
      succeeded: report.succeeded,
      unavailable: report.unavailable,
      unsupported: report.unsupported,
      rateLimited: report.rateLimited,
      failed: report.failed,
      skipped: report.skipped,
    },
    byPlatform: report.byPlatform,
    failures: report.failures.filter((f) => f.workspaceId === workspaceId),
    skips: report.skips.filter((s) => s.workspaceId === workspaceId),
    fatalError: report.fatalError,
    diagnosis: report.diagnosis,
  };
}

export function sweepTitle(report: SweepReport, workspaceId: string): string {
  if (report.phase === "failed") return "Metrics sweep failed";
  const ws = report.byWorkspace[workspaceId];
  if (!ws || ws.attempted === 0) return "Metrics sweep found nothing to measure";
  return `Metrics sweep measured ${ws.connected} of ${ws.attempted} post(s)`;
}

export interface PersistSweepResult {
  workspacesRecorded: number;
  /** True when there was no workspace to attribute the run to. */
  unattributed: boolean;
  errors: string[];
}

export async function persistSweepReport(
  db: SupabaseClient,
  report: SweepReport,
): Promise<PersistSweepResult> {
  const workspaces = resolveReportWorkspaces(report);
  if (workspaces.length === 0) {
    return { workspacesRecorded: 0, unattributed: true, errors: [] };
  }

  const errors: string[] = [];
  let recorded = 0;
  for (const workspaceId of workspaces) {
    const outcome = await recordSystemActivity(db, {
      workspaceId,
      eventType:
        report.phase === "failed" ? SWEEP_FAILED_EVENT_TYPE : SWEEP_EVENT_TYPE,
      title: sweepTitle(report, workspaceId),
      description: report.diagnosis,
      entityType: "metrics_sweep",
      entityId: null,
      metadata: workspaceSummary(report, workspaceId) as unknown as Record<
        string,
        unknown
      >,
      source: "system",
    });
    if (outcome.recorded) recorded += 1;
    else if (outcome.error) errors.push(`${workspaceId}: ${outcome.error}`);
  }
  return { workspacesRecorded: recorded, unattributed: false, errors };
}
