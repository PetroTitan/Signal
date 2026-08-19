import "server-only";
/**
 * MCP read tools for measurement operations.
 *
 * These answer the question the whole milestone exists for — "is social
 * measurement actually working?" — so an operator or agent can diagnose
 * without opening a dashboard.
 *
 * READ-ONLY. None writes a row, none contacts a provider that could
 * mutate anything, and none can bypass a cost gate: the backfill preview
 * here is a plan, and executing one remains a separate authenticated
 * POST with its own confirmation.
 *
 * Every query runs through `loadMeasurementStatus`, which scopes each
 * workspace-owned read to ctx.workspaceId. Run history is intentionally
 * global — a sweep spans workspaces and its record carries no workspace
 * identifier — and the invariant test knows about that exception.
 */

import type { ToolContext } from "../tool-context";
import { failed, ok, type McpToolResponse } from "../responses";
import { loadMeasurementStatus } from "@/core/metrics/health/load-measurement-status.server";
import { listRecentRefreshRuns } from "@/repositories/metrics-refresh-run-repository";
import { describeZeroReason } from "@/core/metrics/refresh/sweep-report";

/** Is social measurement healthy, and what is broken if not? */
export async function socialMeasurementHealth(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.social.measurement_health";
  try {
    const status = await loadMeasurementStatus(ctx.workspaceId, { db: ctx.db });
    return ok({
      tool,
      summary: status.health.summary,
      data: {
        overall: status.health.overall,
        everRan: status.health.everRan,
        lastRunAt: status.health.lastRunAt,
        lastSuccessfulRunAt: status.health.lastSuccessfulRunAt,
        hoursSinceLastRun: status.health.hoursSinceLastRun,
        overdue: status.health.overdue,
        expectedIntervalHours: status.health.expectedIntervalHours,
        lastZeroReason: status.health.lastZeroReason,
        lastZeroReasonExplained: status.health.lastZeroReason
          ? describeZeroReason(status.health.lastZeroReason as never)
          : null,
        providers: status.health.providers,
        evidence: status.health.evidence,
        alerts: status.alerts,
        worstAlert: status.worstAlert,
        budget: status.budget,
      },
      warnings:
        status.health.overall === "never_run"
          ? ["Measurement has never run, so every figure below it is absent rather than zero."]
          : undefined,
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** Which posts are missing metrics, and how much history is covered? */
export async function socialMeasurementCoverage(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.social.measurement_coverage";
  try {
    const status = await loadMeasurementStatus(ctx.workspaceId, { db: ctx.db });
    return ok({
      tool,
      summary:
        status.coverage.map((c) => c.summary).join(" ") ||
        "Nothing has been published, so there is nothing to measure.",
      data: {
        platforms: status.coverage,
        plan: {
          readNow: status.plan.readNow.length,
          urgent: status.plan.urgent.length,
          backfillOnly: status.plan.backfillOnly.length,
          complete: status.plan.complete,
          waiting: status.plan.waiting,
          unmeasurable: status.plan.unmeasurable,
          summary: status.plan.summary,
        },
        accounts: status.accounts,
      },
      warnings: [
        "Coverage counts only successful publications. Blocked and failed attempts never reached a platform and are excluded.",
        "A post_metrics row that is stale, partial or an error does not count as covered.",
      ],
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** When did measurement last run, and what happened? */
export async function socialRefreshHistory(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.social.refresh_history";
  try {
    const runs = await listRecentRefreshRuns(ctx.db, 20);
    return ok({
      tool,
      summary:
        runs.length === 0
          ? "No refresh run has ever been recorded — measurement has never run."
          : `${runs.length} recent run(s); the last was ${runs[0].phase} at ${runs[0].startedAt}.`,
      data: {
        runs: runs.map((r) => ({
          ...r,
          zeroReasonExplained: r.zeroReason
            ? describeZeroReason(r.zeroReason as never)
            : null,
        })),
      },
      warnings:
        runs.length === 0
          ? ["Zero rows means the sweep has genuinely never run, not that it ran and found nothing."]
          : undefined,
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** What would a historical backfill read, and cost? Preview only. */
export async function socialBackfillPreview(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.social.backfill_preview";
  try {
    const status = await loadMeasurementStatus(ctx.workspaceId, { db: ctx.db });
    const recoverable = status.coverage.reduce((sum, c) => sum + c.backfillRecoverable, 0);
    const byPlatform: Record<string, number> = {};
    for (const c of status.coverage) {
      if (c.backfillRecoverable > 0) byPlatform[c.platform] = c.backfillRecoverable;
    }

    const { assessCost, describeResourcePlan } = await import(
      "@/core/metrics/budget/x-read-budget"
    );
    const assessment = assessCost(byPlatform, {
      configuredRate: process.env.X_READ_PRICE_USD_PER_RESOURCE ?? null,
      nowIso: status.nowIso,
    });

    return ok({
      tool,
      summary:
        recoverable === 0
          ? "No publication is waiting on a backfill."
          : `${recoverable} publication(s) are reachable only by backfill. ${describeResourcePlan(assessment)}`,
      data: {
        recoverableByPlatform: byPlatform,
        totalRecoverable: recoverable,
        resources: assessment.resources,
        estimatedUsd: assessment.estimatedUsd,
        costKnown: assessment.costKnown,
        price: assessment.price,
        budget: status.budget,
      },
      warnings: [
        "This is a preview. Running a backfill is a separate authenticated request with its own confirmation.",
        assessment.costKnown
          ? "Cost is an upper bound; provider-side deduplication may reduce it."
          : "Cost could not be established. An unknown price is not a free one — the run will refuse without explicit authorisation.",
      ],
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}
