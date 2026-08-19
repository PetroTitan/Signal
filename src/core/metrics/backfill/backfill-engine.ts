import "server-only";
/**
 * Bounded historical backfill — execution.
 *
 * Runs an already-approved `BackfillPlan` against live providers. Every
 * property the operation needs is enforced here rather than assumed:
 *
 *   explicit invocation  — only reachable from POST /api/metrics/backfill
 *   bounded              — the plan is capped before we get here
 *   read-only            — it calls the same metric fetchers the sweep
 *                          uses; no publisher, no write endpoint, no
 *                          record mutation of any kind
 *   idempotent           — persistence goes through persistRefreshedMetrics,
 *                          whose canonical upsert keys on
 *                          (publish_history_id, source) and whose
 *                          snapshot upsert is hour-bucketed with
 *                          ignoreDuplicates
 *   retry-safe           — a re-run over the same range re-reads and
 *                          re-upserts; no duplicate rows, no double spend
 *                          beyond the provider's own dedup
 *   progress             — reported per provider, per batch
 *
 * The cost gate lives in the planner and is re-checked here, because a
 * function that spends money should not trust that someone upstream
 * checked. `executePlan` refuses a plan whose gate is closed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVerifiedMetrics } from "../fetch-metrics";
import type { MetricsResult } from "../metrics-provider";
import { persistRefreshedMetrics } from "@/repositories/post-metrics-repository";
import { redactSecrets } from "../refresh/sweep-report";
import type { BackfillCandidate, BackfillPlan } from "./backfill-plan";

/** Backfilled rows are historical: there is no urgency to re-read them,
 *  and scheduling one would put the whole history back into the nightly
 *  sweep. They are enrolled with no next refresh; the sweep's own
 *  cadence takes over for anything still inside its window. */
const BACKFILL_NEXT_REFRESH_AT = null;

export interface BackfillDeps {
  /** Injected so the engine is testable without touching a provider. */
  fetchOne: (candidate: BackfillCandidate) => Promise<MetricsResult>;
  persist: (input: {
    candidate: BackfillCandidate;
    result: MetricsResult;
  }) => Promise<void>;
}

export interface BackfillPostOutcome {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  publishedAt: string;
  status: MetricsResult["status"] | "failed";
  /** True only when the provider returned real counts. */
  measured: boolean;
  rateLimited: boolean;
  error: string | null;
}

export interface BackfillPlatformProgress {
  platform: string;
  batches: number;
  attempted: number;
  measured: number;
  unavailable: number;
  unsupported: number;
  rateLimited: number;
  failed: number;
}

export interface BackfillRunResult {
  ok: boolean;
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** False for a dry run — nothing was read and nothing was written. */
  executed: boolean;
  refusal: string | null;
  attempted: number;
  measured: number;
  rateLimited: number;
  failed: number;
  byPlatform: Record<string, BackfillPlatformProgress>;
  outcomes: BackfillPostOutcome[];
  summary: string;
}

function emptyProgress(platform: string): BackfillPlatformProgress {
  return {
    platform,
    batches: 0,
    attempted: 0,
    measured: 0,
    unavailable: 0,
    unsupported: 0,
    rateLimited: 0,
    failed: 0,
  };
}

export async function executePlan(
  plan: BackfillPlan,
  deps: BackfillDeps,
  options: { runId: string; startedAt: string; nowIso?: string },
): Promise<BackfillRunResult> {
  const base = {
    runId: options.runId,
    startedAt: options.startedAt,
    byPlatform: {} as Record<string, BackfillPlatformProgress>,
    outcomes: [] as BackfillPostOutcome[],
    attempted: 0,
    measured: 0,
    rateLimited: 0,
    failed: 0,
  };

  // Re-check the gate. Spending money on someone else's say-so is how a
  // guard gets bypassed by a refactor.
  if (!plan.gate.allowed) {
    return {
      ...base,
      ok: false,
      finishedAt: options.nowIso ?? options.startedAt,
      executed: false,
      refusal: plan.gate.message,
      summary: `Refused: ${plan.gate.message}`,
    };
  }
  if (plan.selected.length === 0) {
    return {
      ...base,
      ok: true,
      finishedAt: options.nowIso ?? options.startedAt,
      executed: false,
      refusal: null,
      summary: "Nothing to backfill in the requested range.",
    };
  }

  for (const batch of plan.batches) {
    const progress = (base.byPlatform[batch.platform] ??= emptyProgress(batch.platform));
    progress.batches += 1;

    for (const candidate of batch.candidates) {
      base.attempted += 1;
      progress.attempted += 1;
      try {
        const result = await deps.fetchOne(candidate);
        // Persist BEFORE tallying, so a write failure is recorded as a
        // failure rather than being reported as a successful measurement.
        await deps.persist({ candidate, result });

        const rateLimited = Boolean(result.rateLimited);
        if (rateLimited) {
          base.rateLimited += 1;
          progress.rateLimited += 1;
        } else if (result.status === "connected") {
          base.measured += 1;
          progress.measured += 1;
        } else if (result.status === "unsupported") {
          progress.unsupported += 1;
        } else {
          progress.unavailable += 1;
        }

        base.outcomes.push({
          workspaceId: candidate.workspaceId,
          publishHistoryId: candidate.publishHistoryId,
          platform: candidate.platform,
          publishedAt: candidate.publishedAt,
          status: result.status,
          measured: result.status === "connected" && !rateLimited,
          rateLimited,
          error: result.error ? redactSecrets(result.error) : null,
        });
      } catch (err) {
        base.failed += 1;
        progress.failed += 1;
        base.outcomes.push({
          workspaceId: candidate.workspaceId,
          publishHistoryId: candidate.publishHistoryId,
          platform: candidate.platform,
          publishedAt: candidate.publishedAt,
          status: "failed",
          measured: false,
          rateLimited: false,
          error: redactSecrets(err),
        });
      }
    }
  }

  const finishedAt = options.nowIso ?? new Date().toISOString();
  return {
    ...base,
    ok: true,
    finishedAt,
    executed: true,
    refusal: null,
    summary: summarise(base),
  };
}

function summarise(base: {
  attempted: number;
  measured: number;
  rateLimited: number;
  failed: number;
  byPlatform: Record<string, BackfillPlatformProgress>;
}): string {
  const perPlatform = Object.values(base.byPlatform)
    .sort((a, b) => a.platform.localeCompare(b.platform))
    .map(
      (p) =>
        `${p.platform}: ${p.measured}/${p.attempted} measured` +
        (p.rateLimited ? `, ${p.rateLimited} rate-limited` : "") +
        (p.unavailable ? `, ${p.unavailable} unavailable` : "") +
        (p.failed ? `, ${p.failed} failed` : ""),
    )
    .join("; ");
  const retryNote = base.rateLimited > 0
    ? " Rate-limited posts were not measured; re-run the same range to pick them up."
    : "";
  return `Backfilled ${base.measured} of ${base.attempted} post(s). ${perPlatform}.${retryNote}`;
}

/**
 * Live wiring. `fetchOne` is the same read path the sweep uses, so the
 * backfill can never reach an endpoint the sweep cannot.
 */
export function buildLiveBackfillDeps(db: SupabaseClient): BackfillDeps {
  return {
    fetchOne: (candidate) =>
      fetchVerifiedMetrics({
        platform: candidate.platform,
        externalPostId: candidate.externalPostId,
        permalink: candidate.permalink,
      }),
    persist: async ({ candidate, result }) => {
      await persistRefreshedMetrics({
        workspaceId: candidate.workspaceId,
        publishHistoryId: candidate.publishHistoryId,
        platform: candidate.platform,
        source: result.source,
        externalPostId: result.externalPostId,
        status: result.status,
        metrics: result.metrics as Record<string, unknown>,
        error: result.error ?? null,
        nextRefreshAt: BACKFILL_NEXT_REFRESH_AT,
        db,
      });
    },
  };
}
