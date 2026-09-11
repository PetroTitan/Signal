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
  applyRunOutcome,
  countMembersByStatus,
  ensureRun,
  getIdentityUsage,
  listDueCampaigns,
  reserveAndClaim,
  resumeRateLimitedRun,
  type ReservationReason,
  acquireDispatchLease,
  releaseDispatchLease,
  updateCampaign,
  updateRun,
} from "@/repositories/bluesky-campaign-repository";
import type {
  BlueskyFollowCampaignRow,
  BlueskyFollowCampaignRunRow,
} from "@/lib/supabase/types";
import { computeEffectiveQuota, IDENTITY_DAILY_FOLLOW_CEILING } from "./quota";
import { computeNextRunAt, isWithinWindow, localClockAt } from "./campaign-day";
import { resolveKillSwitch } from "./kill-switch.server";
import {
  processCampaignChunk,
  CAMPAIGN_CHUNK_SIZE,
  LEASE_SECONDS,
  DISPATCH_LEASE_SECONDS,
} from "./worker.server";
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

/** The later of two optional instants, or null when neither is set. */
function laterOf(a: string | null, b: string | null): Date | null {
  const times = [a, b]
    .filter((v): v is string => Boolean(v))
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (times.length === 0) return null;
  return times.reduce((x, y) => (x.getTime() >= y.getTime() ? x : y));
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
    await completeCampaign(campaign, input.db, now);
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

  let run = await ensureRun({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    localDate: clock.localDate,
    requestedQuota: campaign.requested_daily_quota,
    effectiveQuota: quota.effective,
    effectiveReason: quota.reason,
    db: input.db,
  });

  // A rate-limited run may return to life LATER THE SAME DAY.
  //
  // Previously `status !== 'running'` bailed out permanently, so a 429
  // at 10:00 forfeited the rest of the day's quota even after the
  // provider's own reset had passed. The transition is guarded inside
  // the RPC: only a rate_limited run whose reset has elapsed moves, so
  // an operator pause is never undone, and it is the SAME run — a
  // second run for the day would double the budget.
  if (run.status === "rate_limited") {
    const resumed = await resumeRateLimitedRun({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      db: input.db,
    });
    if (resumed && resumed.status === "running") {
      run = resumed;
      await updateCampaign({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        status: "active",
        rateLimitedUntil: null,
        expectedStatuses: ["active", "rate_limited"],
        db: input.db,
      });
    }
  }

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
    // BOTH windows, whichever is later. The run is created fresh each
    // local day and carries no rate-limit state, so consulting only the
    // run would let a campaign that was rate-limited yesterday evening
    // resume this morning as though nothing had happened — and the
    // provider's reset can easily outlive the local date boundary.
    rateLimitedUntil: laterOf(
      campaign.rate_limited_until,
      run.rate_limited_until,
    ),
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

  // A cheap pre-check so an exhausted day does not resolve a session or
  // touch the provider. It is NOT the authority: the reservation RPC
  // recomputes headroom under a row lock, and only that is binding.
  //
  // `already_following_count` is deliberately absent — those members
  // return before an attempt is made, so they are not in
  // `attempted_count` and subtracting them would double-count and let
  // the day overrun. Only `skipped_count` is an attempt that cost no
  // quota.
  const consumedToday = Math.max(0, run.attempted_count - run.skipped_count);
  const quotaRemaining = Math.max(0, live.effective - consumedToday);
  if (quotaRemaining === 0) {
    await finishRun(campaign, run, input.db, "daily quota reached", now);
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
  //
  // Each iteration RESERVES quota and receives exactly the members that
  // reservation covers. The reservation is what bounds total attempts:
  // two dispatchers claiming disjoint members still both attempt, and
  // only a reservation taken under a row lock stops them collectively
  // exceeding the day.
  const claimedBy = `tick-${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── One dispatcher per campaign-day.
  //
  // Reservations bound how much quota concurrent workers can spend, but
  // the consecutive-failure breaker cannot be made correct by
  // arithmetic: "consecutive" is a property of a sequence, and two
  // interleaved workers do not have one. Both read 3 failures, both
  // write 4, and a breaker set to trip at 5 never trips while eight
  // follows in a row fail.
  //
  // Losing the race is a normal outcome, not an error: another tick
  // already has this campaign.
  const holdsLease = await acquireDispatchLease({
    workspaceId: campaign.workspace_id,
    runId: run.id,
    owner: claimedBy,
    leaseSeconds: DISPATCH_LEASE_SECONDS,
    db: input.db,
  });
  if (!holdsLease) {
    out.note = "another dispatcher holds this campaign";
    return out;
  }

  try {
    return await runChunks({
      args, input, campaign, run, session, live, usageDate, claimedBy, now, out,
    });
  } finally {
    await releaseDispatchLease({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      owner: claimedBy,
      db: input.db,
    });
  }
}

/**
 * The chunk loop, under the dispatch lease.
 *
 * Split out so the lease is released on every exit path — including the
 * rate-limit and failure returns, which are the ones most likely to be
 * taken.
 */
async function runChunks(ctx: {
  args: { remainingBudgetMs: () => number };
  input: DispatchInput;
  campaign: BlueskyFollowCampaignRow;
  run: BlueskyFollowCampaignRunRow;
  session: Awaited<ReturnType<typeof resolveRelationshipSession>> & { ok: true };
  live: { effective: number };
  usageDate: string;
  claimedBy: string;
  now: Date;
  out: RunCampaignResult;
}): Promise<RunCampaignResult> {
  const { args, input, campaign, session, live, usageDate, claimedBy, now, out } = ctx;
  const run = ctx.run;
  let consecutive = run.consecutive_failures;
  let stop: NextAction | null = null;
  let totalSucceeded = run.succeeded_count;
  // Why the loop stopped. Set from the reservation itself rather than
  // from a quota figure computed before the loop began — that figure is
  // stale the moment any chunk runs, and relying on it left a campaign
  // whose quota ran out mid-pass with its run never closed and
  // `next_run_at` still pointing at now, so every subsequent tick
  // re-entered it for the rest of the day.
  let lastReason: ReservationReason = "queue_empty";

  while (args.remainingBudgetMs() > 0) {
    const reservation = await reserveAndClaim({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      runId: run.id,
      operatorAccountId: campaign.operator_account_id,
      usageDate,
      requested: live.effective,
      identityCeiling: IDENTITY_DAILY_FOLLOW_CEILING,
      chunkSize: CAMPAIGN_CHUNK_SIZE,
      leaseSeconds: LEASE_SECONDS,
      claimedBy,
      db: input.db,
    });

    lastReason = reservation.reason;
    // Nothing reserved. WHY decides what happens after the loop.
    if (reservation.reserved === 0 || !reservation.reservationId) break;

    const chunk = await processCampaignChunk({
      campaign,
      runId: run.id,
      session,
      members: reservation.members,
      quotaRemaining: reservation.reserved,
      consecutiveFailures: consecutive,
      claimedBy,
      initiatedBy: campaign.created_by,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
      db: input.db,
      sleep: input.sleep,
      interRequestMs: input.interRequestMs,
    });

    out.ranChunks += 1;
    consecutive = chunk.consecutiveFailures;
    out.attempted += chunk.attempted;
    out.succeeded += chunk.succeeded;
    out.alreadyFollowing += chunk.alreadyFollowing;
    out.skipped += chunk.skipped;
    out.failed += chunk.failed;

    // Counters as DELTAS, and the reservation consumed in the same
    // statement. Writing absolutes from the snapshot read at the top of
    // this function loses every concurrent increment.
    const updated = await applyRunOutcome({
      workspaceId: campaign.workspace_id,
      runId: run.id,
      operatorAccountId: campaign.operator_account_id,
      usageDate,
      attempted: chunk.attempted,
      succeeded: chunk.succeeded,
      alreadyFollowing: chunk.alreadyFollowing,
      skipped: chunk.skipped,
      failed: chunk.failed,
      recordsCreated: chunk.recordsCreated,
      // The reservation ITSELF, not a count. The RPC verifies that
      // this reservation belongs to this run before applying anything,
      // marks it settled so a duplicate settlement is a no-op, and
      // releases exactly its own quota — never someone else's.
      reservationId: reservation.reservationId,
      consecutiveFailures: consecutive,
      rateLimitedUntil:
        chunk.next.kind === "stop_run" && chunk.next.resumeAfter
          ? chunk.next.resumeAfter.toISOString()
          : null,
      rateLimitRemaining: chunk.rateLimit?.remaining ?? null,
      rateLimitResetAt:
        chunk.rateLimit?.resetAt != null
          ? new Date(chunk.rateLimit.resetAt * 1000).toISOString()
          : null,
      db: input.db,
    });
    if (updated?.settled) totalSucceeded = updated.succeededCount;

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
      // Come back NO EARLIER than the provider's own reset, and only
      // inside the execution window. Leaving `next_run_at` untouched
      // made the campaign due immediately: every tick re-read it, found
      // the run still rate-limited, and burned a dispatcher pass doing
      // nothing until the reset finally elapsed.
      const retryAt = computeNextRunAt({
        from: resumeAfter,
        timezone: campaign.timezone,
        window: {
          startMinute: campaign.execution_window_start_minute,
          endMinute: campaign.execution_window_end_minute,
        },
      });
      await updateCampaign({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        rateLimitedUntil: resumeAfter.toISOString(),
        nextRunAt: retryAt.toISOString(),
        expectedStatuses: ["active"],
        db: input.db,
      });
    }
    out.note = stop.reason;
    return out;
  }

  // Why the loop ended decides what happens now.
  const after = await countMembersByStatus({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    db: input.db,
  });
  if (after.remainingEligible === 0) {
    await finishRun(campaign, run, input.db, "queue exhausted", now);
    await completeCampaign(campaign, input.db, now);
    out.note = "campaign completed";
    return out;
  }

  // A quota that ran out DURING the pass must still close the day and
  // schedule tomorrow. Reading a pre-loop figure here meant a campaign
  // that spent its quota mid-pass left the run open and `next_run_at`
  // unchanged, so the dispatcher woke on it every five minutes until
  // midnight and reserved nothing each time.
  if (lastReason === "quota_exhausted" || lastReason === "identity_exhausted") {
    const reason =
      lastReason === "identity_exhausted"
        ? "identity daily ceiling reached"
        : "daily quota reached";
    await finishRun(campaign, run, input.db, reason, now);
    out.note = `${reason} (${totalSucceeded} follow(s) created today)`;
    return out;
  }

  // `queue_empty` with members still eligible means every remaining row
  // is leased by someone else or waiting on a backoff. Leave the run
  // open; the next tick picks them up.
  out.note = out.note ?? `stopped: ${lastReason}`;
  return out;
}

/**
 * Close out the day's run and schedule the next.
 *
 * Takes `now` rather than reading the clock. The first version called
 * `new Date()` here while the dispatcher worked from an injected
 * instant, so the next-run hint was computed against a different time
 * than everything else — which made a resumed campaign look "not yet
 * due" depending on when the code happened to run.
 */
async function finishRun(
  campaign: BlueskyFollowCampaignRow,
  run: BlueskyFollowCampaignRunRow,
  db: SupabaseClient | undefined,
  reason: string,
  now: Date,
): Promise<void> {
  await updateRun({
    workspaceId: campaign.workspace_id,
    runId: run.id,
    status: "completed",
    completedAt: now.toISOString(),
    effectiveQuotaReason: reason,
    db,
  });
  // Schedule for the NEXT local day, not the next window slot today.
  // Today's quota is spent, so pointing at "five minutes from now"
  // would have the dispatcher reconsider this campaign on every tick
  // for the rest of the day — roughly 288 wake-ups to conclude each
  // time that the day's run is already complete.
  const tomorrow = nextLocalDate(now, campaign.timezone);
  await updateCampaign({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    nextRunAt: computeNextRunAt({
      from: now,
      timezone: campaign.timezone,
      window: {
        startMinute: campaign.execution_window_start_minute,
        endMinute: campaign.execution_window_end_minute,
      },
      notBeforeLocalDate: tomorrow,
    }).toISOString(),
    expectedStatuses: ["active"],
    db,
  });
}

/**
 * The local calendar date after the one `instant` falls on.
 *
 * Computed by stepping a full day forward and re-reading the local
 * date, rather than by adding one to the date string — which would
 * produce "2026-09-32" at a month boundary, and would also be wrong on
 * a DST day where the local day is 23 or 25 hours long.
 */
function nextLocalDate(instant: Date, timezone: string): string {
  return localClockAt(
    new Date(instant.getTime() + 24 * 60 * 60_000),
    timezone,
  ).localDate;
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
  now: Date,
): Promise<boolean> {
  const updated = await updateCampaign({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    status: "completed",
    completedAt: now.toISOString(),
    nextRunAt: null,
    expectedStatuses: ["active"],
    db,
  });
  return updated !== null;
}
