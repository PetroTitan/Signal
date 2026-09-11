import "server-only";
/**
 * The daily dispatcher.
 *
 * Invoked by cron. Its whole job is: decide whether a campaign should
 * do work right now, get-or-create today's run, compute what may be
 * attempted, and drive chunks until something says stop.
 *
 * IDEMPOTENCE
 * -----------
 * Vercel Cron is at-least-once. Two deliveries arriving together must
 * not produce two daily runs, two claims on one member, or two follows.
 * None of that is defended in this file — it is defended in the
 * database:
 *
 *   - `unique (campaign_id, local_date)` + `ON CONFLICT DO NOTHING`
 *     means the second delivery finds the first's run.
 *   - `FOR UPDATE SKIP LOCKED` means the second worker claims different
 *     rows, not the same ones.
 *   - `unique (campaign_id, campaign_member_id)` on the action table
 *     means one member yields one action however many times anything
 *     repeats.
 *
 * This file can therefore be re-entered freely, which is the only
 * property that makes at-least-once delivery safe.
 *
 * NO TIMERS, NO RECURSION, NO SELF-INVOCATION
 * -------------------------------------------
 * A tick runs chunks until its wall-clock budget is spent and then
 * RETURNS. The next cron delivery continues. There is no setTimeout, no
 * re-entrant HTTP call to itself, and no queue of its own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  ensureRun,
  getIdentityUsage,
  countMembersByStatus,
  listDueCampaigns,
  recordIdentityUsage,
  updateCampaign,
  updateRun,
} from "@/repositories/bluesky-campaign-repository";
import type {
  BlueskyFollowCampaignRow,
  BlueskyFollowCampaignRunRow,
} from "@/lib/supabase/types";
import { computeEffectiveQuota } from "./quota";
import { computeNextRunAt, isWithinWindow, localClockAt } from "./campaign-day";
import { resolveKillSwitch } from "./kill-switch.server";
import { processCampaignChunk, CAMPAIGN_CHUNK_SIZE } from "./worker.server";
import type { NextAction } from "./outcomes";

/**
 * Wall-clock budget for one tick's chunk loop.
 *
 * The route declares `maxDuration = 300`. Stopping at 240s leaves a
 * full minute to persist the run's final state and return a response —
 * being killed mid-write is the one outcome worth spending a margin to
 * avoid, because it is the only one that loses information rather than
 * just time.
 */
export const TICK_BUDGET_MS = 240_000;

export interface DispatchResult {
  campaignsConsidered: number;
  campaignsRun: number;
  chunksProcessed: number;
  attempted: number;
  succeeded: number;
  alreadyFollowing: number;
  skipped: number;
  failed: number;
  /** Per-campaign notes, for the cron response and the logs. */
  notes: string[];
}

export interface DispatchInput {
  nowIso?: string;
  /** Restrict to one campaign. Used by the manual "run now" control. */
  campaignId?: string;
  workspaceId?: string;
  maxCampaigns?: number;
  budgetMs?: number;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
  /** Injected so a test can drive the clock without waiting. */
  monotonicNowMs?: () => number;
}

const empty = (): DispatchResult => ({
  campaignsConsidered: 0,
  campaignsRun: 0,
  chunksProcessed: 0,
  attempted: 0,
  succeeded: 0,
  alreadyFollowing: 0,
  skipped: 0,
  failed: 0,
  notes: [],
});

/**
 * One dispatcher pass.
 *
 * Never throws: a cron endpoint that 500s tells an operator nothing
 * useful and may be retried aggressively by the platform. Failures are
 * recorded against the campaign and reported in the result.
 */
export async function dispatchCampaigns(
  input: DispatchInput = {},
): Promise<DispatchResult> {
  const result = empty();
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const monotonic = input.monotonicNowMs ?? (() => Date.now());
  const startedAt = monotonic();
  const budget = input.budgetMs ?? TICK_BUDGET_MS;

  let campaigns: BlueskyFollowCampaignRow[];
  try {
    campaigns = await listDueCampaigns({
      nowIso: now.toISOString(),
      limit: input.maxCampaigns ?? 25,
      db: input.db,
    });
  } catch (err) {
    result.notes.push(
      `Could not list due campaigns: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return result;
  }

  if (input.campaignId) {
    campaigns = campaigns.filter((c) => c.id === input.campaignId);
  }
  if (input.workspaceId) {
    campaigns = campaigns.filter((c) => c.workspace_id === input.workspaceId);
  }
  result.campaignsConsidered = campaigns.length;

  for (const campaign of campaigns) {
    if (monotonic() - startedAt >= budget) {
      result.notes.push(
        "Tick budget spent; remaining campaigns continue on the next delivery.",
      );
      break;
    }
    try {
      const ran = await runCampaign({
        campaign,
        now,
        input,
        remainingBudgetMs: () => budget - (monotonic() - startedAt),
      });
      if (ran.ranChunks > 0) result.campaignsRun += 1;
      result.chunksProcessed += ran.ranChunks;
      result.attempted += ran.attempted;
      result.succeeded += ran.succeeded;
      result.alreadyFollowing += ran.alreadyFollowing;
      result.skipped += ran.skipped;
      result.failed += ran.failed;
      if (ran.note) result.notes.push(`${campaign.name}: ${ran.note}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      result.notes.push(`${campaign.name}: dispatch failed — ${message}`);
      // A campaign that threw is not left `active` and silently
      // looping: it is marked failed so an operator sees it.
      await updateCampaign({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        status: "failed",
        lastErrorCode: "dispatch_error",
        lastErrorMessage: message,
        expectedStatuses: ["active"],
        db: input.db,
      }).catch(() => undefined);
    }
  }

  return result;
}

interface RunCampaignResult {
  ranChunks: number;
  attempted: number;
  succeeded: number;
  alreadyFollowing: number;
  skipped: number;
  failed: number;
  note: string | null;
}

async function runCampaign(args: {
  campaign: BlueskyFollowCampaignRow;
  now: Date;
  input: DispatchInput;
  remainingBudgetMs: () => number;
}): Promise<RunCampaignResult> {
  const { campaign, now, input } = args;
  const out: RunCampaignResult = {
    ranChunks: 0,
    attempted: 0,
    succeeded: 0,
    alreadyFollowing: 0,
    skipped: 0,
    failed: 0,
    note: null,
  };

  // ── Kill switches. Before anything else, and before any provider
  //    call. Fails closed if the switches cannot be read.
  const kill = await resolveKillSwitch({
    workspaceId: campaign.workspace_id,
    operatorAccountId: campaign.operator_account_id,
    db: input.db,
  });
  if (kill.engaged) {
    out.note = `stopped by the ${kill.scope} kill switch`;
    return out;
  }

  // ── Window. Evaluated on the instant, so a DST-skipped local hour
  //    simply never matches rather than producing an invalid timestamp.
  const clock = localClockAt(now, campaign.timezone);
  const window = {
    startMinute: campaign.execution_window_start_minute,
    endMinute: campaign.execution_window_end_minute,
  };
  if (!isWithinWindow(now, campaign.timezone, window)) {
    await updateCampaign({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      nextRunAt: computeNextRunAt({
        from: now,
        timezone: campaign.timezone,
        window,
        notBeforeLocalDate: campaign.start_date,
      }).toISOString(),
      expectedStatuses: ["active"],
      db: input.db,
    });
    out.note = `outside the execution window (local ${clock.localDate})`;
    return out;
  }

  // ── Start date.
  if (campaign.start_date && clock.localDate < campaign.start_date) {
    out.note = `starts on ${campaign.start_date} (local date is ${clock.localDate})`;
    return out;
  }

  // ── Queue state. Exact counts, not a scan.
  const counts = await countMembersByStatus({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    db: input.db,
  });
  if (counts.remainingEligible === 0) {
    await completeCampaign(campaign, input.db);
    out.note = "every member is terminal — campaign completed";
    return out;
  }

  // ── Identity's combined usage today. Two campaigns on one identity
  //    share this, because Bluesky's budget is per account.
  const usageDate = now.toISOString().slice(0, 10);
  const usage = await getIdentityUsage({
    workspaceId: campaign.workspace_id,
    operatorAccountId: campaign.operator_account_id,
    usageDate,
    db: input.db,
  });

  // ── Today's run. Idempotent: a duplicate delivery finds this one.
  const quota = computeEffectiveQuota({
    requested: campaign.requested_daily_quota,
    identityFollowsToday: usage?.follows_created ?? 0,
    consecutiveFailures: 0,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    attemptedToday: 0,
    succeededToday: 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until
      ? new Date(campaign.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  const run = await ensureRun({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    localDate: clock.localDate,
    requestedQuota: campaign.requested_daily_quota,
    effectiveQuota: quota.effective,
    effectiveReason: quota.reason,
    db: input.db,
  });

  if (run.status !== "running") {
    out.note = `today's run is ${run.status}`;
    return out;
  }

  // Re-evaluate against what this run has ALREADY done today — the
  // run may have been created by an earlier tick.
  const live = computeEffectiveQuota({
    requested: campaign.requested_daily_quota,
    identityFollowsToday: usage?.follows_created ?? 0,
    consecutiveFailures: run.consecutive_failures,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    attemptedToday: run.attempted_count,
    succeededToday: run.succeeded_count,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: run.rate_limited_until
      ? new Date(run.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  if (live.effective <= 0) {
    await updateRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      status: live.halted ? "paused" : "completed",
      effectiveDailyQuota: 0,
      effectiveQuotaReason: live.reason,
      completedAt: live.halted ? null : new Date().toISOString(),
      db: input.db,
    });
    out.note = live.reason ?? "no quota available";
    return out;
  }

  // Quota ALREADY consumed today, so a tick mid-day does not restart
  // the day's budget. Attempted minus the outcomes that cost nothing.
  const consumedToday =
    run.attempted_count - run.already_following_count - run.skipped_count;
  let quotaRemaining = Math.max(0, live.effective - Math.max(0, consumedToday));
  if (quotaRemaining === 0) {
    await finishRun(campaign, run, input.db, "daily quota reached");
    out.note = "daily quota already reached";
    return out;
  }

  // ── Session. Resolved once and reused across every chunk: Bluesky
  //    allows only 300 createSession calls per account per day, so a
  //    session per chunk would be a self-inflicted outage.
  const session = await resolveRelationshipSession({
    workspaceId: campaign.workspace_id,
    accountId: campaign.operator_account_id,
    db: input.db,
  });
  if (!session.ok) {
    await updateCampaign({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      status: "reauthorization_required",
      lastErrorCode: session.code,
      lastErrorMessage: session.message,
      expectedStatuses: ["active"],
      db: input.db,
    });
    await updateRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      status: "paused",
      lastErrorCode: session.code,
      lastErrorMessage: session.message,
      db: input.db,
    });
    out.note = `session unavailable — ${session.message}`;
    return out;
  }

  // ── The chunk loop.
  const claimedBy = `tick-${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
  let attempted = run.attempted_count;
  let succeeded = run.succeeded_count;
  let alreadyFollowing = run.already_following_count;
  let skipped = run.skipped_count;
  let failed = run.failed_count;
  let consecutive = run.consecutive_failures;
  let stop: NextAction | null = null;

  while (quotaRemaining > 0 && args.remainingBudgetMs() > 0) {
    const chunk = await processCampaignChunk({
      campaign,
      runId: run.id,
      session,
      quotaRemaining: Math.min(quotaRemaining, CAMPAIGN_CHUNK_SIZE),
      consecutiveFailures: consecutive,
      claimedBy,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
      db: input.db,
      sleep: input.sleep,
      interRequestMs: input.interRequestMs,
    });

    if (chunk.claimed === 0) break;

    out.ranChunks += 1;
    attempted += chunk.attempted;
    succeeded += chunk.succeeded;
    alreadyFollowing += chunk.alreadyFollowing;
    skipped += chunk.skipped;
    failed += chunk.failed;
    consecutive = chunk.consecutiveFailures;
    quotaRemaining -= chunk.quotaConsumed;

    out.attempted += chunk.attempted;
    out.succeeded += chunk.succeeded;
    out.alreadyFollowing += chunk.alreadyFollowing;
    out.skipped += chunk.skipped;
    out.failed += chunk.failed;

    // Record the provider-visible consumption immediately, so a crash
    // after this point cannot let a second campaign on the same
    // identity re-spend the same allowance.
    if (chunk.recordsCreated > 0 || chunk.attempted > 0) {
      await recordIdentityUsage({
        workspaceId: campaign.workspace_id,
        operatorAccountId: campaign.operator_account_id,
        usageDate,
        followsCreated: chunk.recordsCreated,
        attemptsMade: chunk.attempted,
      db: input.db,
      });
    }

    await updateRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      attemptedCount: attempted,
      succeededCount: succeeded,
      alreadyFollowingCount: alreadyFollowing,
      skippedCount: skipped,
      failedCount: failed,
      consecutiveFailures: consecutive,
      lastChunkAt: new Date().toISOString(),
      db: input.db,
    });

    if (chunk.next.kind !== "continue") {
      stop = chunk.next;
      break;
    }
  }

  // ── Terminal handling.
  if (stop?.kind === "stop_campaign") {
    await updateCampaign({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      status: stop.campaignStatus,
      lastErrorCode: stop.campaignStatus,
      lastErrorMessage: stop.reason,
      rateLimitedUntil: null,
      expectedStatuses: ["active"],
      db: input.db,
    });
    await updateRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      status: stop.campaignStatus === "rate_limited" ? "rate_limited" : "failed",
      lastErrorCode: stop.campaignStatus,
      lastErrorMessage: stop.reason,
      db: input.db,
    });
    out.note = stop.reason;
    return out;
  }

  if (stop?.kind === "stop_run") {
    const resumeAfter = stop.resumeAfter ?? null;
    await updateRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      status: resumeAfter ? "rate_limited" : "paused",
      rateLimitedUntil: resumeAfter?.toISOString() ?? null,
      lastErrorMessage: stop.reason,
      db: input.db,
    });
    if (resumeAfter) {
      await updateCampaign({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        rateLimitedUntil: resumeAfter.toISOString(),
        expectedStatuses: ["active"],
        db: input.db,
      });
    }
    out.note = stop.reason;
    return out;
  }

  // Quota spent for today, or nothing left to claim.
  const after = await countMembersByStatus({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    db: input.db,
  });
  if (after.remainingEligible === 0) {
    await finishRun(campaign, run, input.db, "queue exhausted");
    await completeCampaign(campaign, input.db);
    out.note = "campaign completed";
    return out;
  }
  if (quotaRemaining <= 0) {
    await finishRun(campaign, run, input.db, "daily quota reached");
    out.note = `daily quota reached (${succeeded} follow(s) created today)`;
  }
  return out;
}

async function finishRun(
  campaign: BlueskyFollowCampaignRow,
  run: BlueskyFollowCampaignRunRow,
  db: SupabaseClient | undefined,
  reason: string,
): Promise<void> {
  await updateRun({
    workspaceId: campaign.workspace_id,
    runId: run.id,
    status: "completed",
    completedAt: new Date().toISOString(),
    effectiveQuotaReason: reason,
    db,
  });
  await updateCampaign({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    nextRunAt: computeNextRunAt({
      from: new Date(),
      timezone: campaign.timezone,
      window: {
        startMinute: campaign.execution_window_start_minute,
        endMinute: campaign.execution_window_end_minute,
      },
    }).toISOString(),
    expectedStatuses: ["active"],
    db,
  });
}

/**
 * Mark a campaign completed — exactly once.
 *
 * The `expectedStatuses` guard is a compare-and-set: two workers
 * reaching the last member together both call this, and only one
 * update matches `status = 'active'`. The other gets zero rows and
 * does nothing, rather than both writing a completion.
 */
async function completeCampaign(
  campaign: BlueskyFollowCampaignRow,
  db: SupabaseClient | undefined,
): Promise<boolean> {
  const updated = await updateCampaign({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    status: "completed",
    completedAt: new Date().toISOString(),
    nextRunAt: null,
    expectedStatuses: ["active"],
    db,
  });
  return updated !== null;
}
