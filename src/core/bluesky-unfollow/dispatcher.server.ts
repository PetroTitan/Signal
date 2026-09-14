import "server-only";
/**
 * The daily unfollow dispatcher.
 *
 * Invoked by the SAME authenticated cron route as the follow
 * dispatcher, immediately after it. Its job: decide whether an unfollow
 * campaign should do work right now, get-or-create today's run, compute
 * what may be attempted, and drive chunks until something says stop.
 *
 * IDEMPOTENCE
 * -----------
 * Vercel Cron is at-least-once. Two deliveries arriving together must
 * not produce two daily runs, two claims on one member, or two deletes.
 * None of that is defended in this file — it is defended in the
 * database, by the same constraints the follow subsystem relies on:
 *
 *   • `unique (campaign_id, local_date)` + `ON CONFLICT DO NOTHING`
 *     means the second delivery finds the first's run.
 *   • `FOR UPDATE SKIP LOCKED` inside the reservation RPC means the
 *     second worker claims different rows, not the same ones.
 *   • `unique (campaign_id, campaign_member_id)` on the action table
 *     means one member yields one action however many times anything
 *     repeats.
 *   • the dispatch lease means one dispatcher per campaign-day, because
 *     "consecutive failures" is a property of a sequence and two
 *     interleaved workers do not have one.
 *
 * This file can therefore be re-entered freely, which is the only
 * property that makes at-least-once delivery safe.
 *
 * NO TIMERS, NO RECURSION, NO SELF-INVOCATION
 * -------------------------------------------
 * A tick runs chunks until its wall-clock budget is spent and then
 * RETURNS. The next cron delivery continues. There is no setTimeout, no
 * re-entrant HTTP call, and no queue of its own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  applyRunOutcome,
  campaignMayComplete,
  resumeRunAfterRecovery,
  countMembersByStatus,
  countUnresolvedCampaignActions,
  ensureRun,
  getIdentityUsage,
  listDueCampaigns,
  reserveAndClaim,
  resumeRateLimitedRun,
  acquireDispatchLease,
  releaseDispatchLease,
  updateCampaign,
  updateRun,
  type ReservationReason,
} from "@/repositories/bluesky-campaign-repository";
import type {
  BlueskyFollowCampaignRow,
  BlueskyFollowCampaignRunRow,
} from "@/lib/supabase/types";
import {
  computeEffectiveUnfollowQuota,
  IDENTITY_DAILY_MUTATION_CEILING,
} from "./quota";
import {
  computeNextRunAt,
  isWithinWindow,
  localClockAt,
} from "@/core/bluesky-campaigns/campaign-day";
import { resolveKillSwitch } from "@/core/bluesky-campaigns/kill-switch.server";
import {
  isRecoverableRunStop,
  recoverReauthorizedCampaigns,
} from "@/core/bluesky-campaigns/dispatcher.server";
import {
  processUnfollowChunk,
  UNFOLLOW_CHUNK_SIZE,
  LEASE_SECONDS,
  DISPATCH_LEASE_SECONDS,
} from "./worker.server";
import type { NextAction } from "./outcomes";

/**
 * Wall-clock budget for one tick's chunk loop.
 *
 * The route declares `maxDuration = 300`, and the follow dispatcher
 * runs first in the same invocation. This budget is applied to whatever
 * time is LEFT, so the two share the request rather than the second one
 * assuming it starts at zero.
 */
export const UNFOLLOW_TICK_BUDGET_MS = 120_000;

export interface UnfollowDispatchResult {
  campaignsConsidered: number;
  campaignsRun: number;
  chunksProcessed: number;
  attempted: number;
  succeeded: number;
  alreadyNotFollowing: number;
  protectedCount: number;
  conflicts: number;
  skipped: number;
  failed: number;
  notes: string[];
}

export interface UnfollowDispatchInput {
  nowIso?: string;
  campaignId?: string;
  workspaceId?: string;
  maxCampaigns?: number;
  budgetMs?: number;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
  monotonicNowMs?: () => number;
  currentTime?: () => Date;
}

const empty = (): UnfollowDispatchResult => ({
  campaignsConsidered: 0,
  campaignsRun: 0,
  chunksProcessed: 0,
  attempted: 0,
  succeeded: 0,
  alreadyNotFollowing: 0,
  protectedCount: 0,
  conflicts: 0,
  skipped: 0,
  failed: 0,
  notes: [],
});

/** The later of two optional instants, or null when neither is set. */
function laterOf(a: string | null, b: string | null): Date | null {
  const times = [a, b]
    .filter((v): v is string => Boolean(v))
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (times.length === 0) return null;
  return times.reduce((x, y) => (x.getTime() >= y.getTime() ? x : y));
}

/**
 * One dispatcher pass.
 *
 * Never throws: a cron endpoint that 500s tells an operator nothing and
 * may be retried aggressively by the platform. Failures are recorded
 * against the campaign and reported in the result.
 */
export async function dispatchUnfollowCampaigns(
  input: UnfollowDispatchInput = {},
): Promise<UnfollowDispatchResult> {
  const result = empty();
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const monotonic = input.monotonicNowMs ?? (() => Date.now());
  const startedAt = monotonic();
  const budget = input.budgetMs ?? UNFOLLOW_TICK_BUDGET_MS;

  let campaigns: BlueskyFollowCampaignRow[];
  try {
    campaigns = await listDueCampaigns({
      nowIso: now.toISOString(),
      // THE FILTER. Never omitted, never parameterised from a caller:
      // this dispatcher deletes records, and it may only ever see
      // campaigns whose operator asked for deletions.
      kind: "unfollow",
      // `rate_limited` is a state an operator can SEE, and a state the
      // scheduler must be able to leave. Listing only `active` would
      // make a 429 permanent.
      statuses: ["active", "rate_limited"],
      limit: input.maxCampaigns ?? 25,
      db: input.db,
    });
  } catch (err) {
    result.notes.push(
      `Could not list due unfollow campaigns: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
    return result;
  }

  if (input.campaignId) {
    campaigns = campaigns.filter((c) => c.id === input.campaignId);
  }
  if (input.workspaceId) {
    campaigns = campaigns.filter((c) => c.workspace_id === input.workspaceId);
  }

  // Campaigns stopped for reauthorization whose account is signed in
  // again come back automatically — the same recovery the follow
  // dispatcher performs, scoped to this kind.
  try {
    const recovered = await recoverReauthorizedCampaigns({
      nowIso: now.toISOString(),
      input,
      notes: result.notes,
      kind: "unfollow",
    });
    campaigns = campaigns.concat(recovered);
  } catch (err) {
    result.notes.push(
      `Reauthorization recovery skipped: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // Belt and braces. `listDueCampaigns` already filtered, and the
  // database refuses independently — but this dispatcher is the one
  // holding a delete path, so it re-reads the discriminator on the row
  // in front of it rather than trusting the query that produced it.
  campaigns = campaigns.filter((c) => (c as { kind?: string }).kind === "unfollow");

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
      result.alreadyNotFollowing += ran.alreadyNotFollowing;
      result.protectedCount += ran.protectedCount;
      result.conflicts += ran.conflicts;
      result.skipped += ran.skipped;
      result.failed += ran.failed;
      if (ran.note) result.notes.push(`${campaign.name}: ${ran.note}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      result.notes.push(`${campaign.name}: dispatch failed — ${message}`);
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
  alreadyNotFollowing: number;
  protectedCount: number;
  conflicts: number;
  skipped: number;
  failed: number;
  note: string | null;
}

async function runCampaign(args: {
  campaign: BlueskyFollowCampaignRow;
  now: Date;
  input: UnfollowDispatchInput;
  remainingBudgetMs: () => number;
}): Promise<RunCampaignResult> {
  const { campaign, now, input } = args;
  const out: RunCampaignResult = {
    ranChunks: 0,
    attempted: 0,
    succeeded: 0,
    alreadyNotFollowing: 0,
    protectedCount: 0,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    note: null,
  };

  // ── Kill switches, before anything else and before any provider
  //    call. "Stop this identity" stops BOTH kinds, because the switch
  //    is keyed on the identity and both dispatchers consult it.
  //    Fails closed if the switches cannot be read.
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
    out.note = (await completeCampaign(campaign, input.db, now))
      ? "every profile is finished — campaign completed"
      : "no eligible members, but work is still outstanding — not completed";
    return out;
  }

  // ── The identity's COMBINED usage today.
  //
  // `attempts_made` counts provider mutations of BOTH kinds, because
  // `consume_bluesky_member_quota` increments it for both — so a day
  // spent following genuinely leaves less room for unfollowing. That
  // shared counter IS the combined ceiling, and it cannot be forgotten
  // by a caller because no caller performs the coupling.
  const usageDate = now.toISOString().slice(0, 10);
  const usage = await getIdentityUsage({
    workspaceId: campaign.workspace_id,
    operatorAccountId: campaign.operator_account_id,
    usageDate,
    db: input.db,
  });
  const identityMutationsToday = Math.max(
    usage?.attempts_made ?? 0,
    (usage?.follows_created ?? 0) +
      ((usage as { unfollows_deleted?: number } | null)?.unfollows_deleted ?? 0),
  );

  const quota = computeEffectiveUnfollowQuota({
    requested: campaign.requested_daily_quota,
    identityMutationsToday,
    consecutiveFailures: 0,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    resolvedToday: 0,
    succeededToday: 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until
      ? new Date(campaign.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    boundByQueue: false,
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

  // Session, resolved ONCE per pass and carried across chunks — and
  // resolved before the run is judged, so a run stopped for
  // authentication can be resumed the moment the session works again.
  const session = await resolveRelationshipSession({
    workspaceId: campaign.workspace_id,
    accountId: campaign.operator_account_id,
    db: input.db,
    fetchImpl: input.fetchImpl,
  });

  if (
    session.ok &&
    (run.status === "paused" || run.status === "failed") &&
    isRecoverableRunStop(run.last_error_code)
  ) {
    const resumed = await resumeRunAfterRecovery({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      localDate: clock.localDate,
      db: input.db,
    });
    if (resumed.resumed) {
      run = {
        ...run,
        status: "running",
        rate_limited_until: null,
        last_error_code: null,
        last_error_message: null,
      };
      out.note = "today's run resumed after recovery";
    }
  }

  // A rate-limited run may return to life LATER THE SAME DAY. The
  // transition is guarded inside the RPC: only a rate_limited run whose
  // reset has elapsed moves, so AN OPERATOR PAUSE IS NEVER UNDONE, and
  // it is the SAME run — a second run for the day would double the
  // budget.
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

  // The run is live again, so the campaign must not still advertise a
  // rate limit. Compare-and-set: only a rate_limited campaign moves,
  // so an operator pause landing in between is never overwritten.
  if (campaign.status === "rate_limited") {
    await updateCampaign({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      status: "active",
      rateLimitedUntil: null,
      expectedStatuses: ["rate_limited"],
      db: input.db,
    });
    campaign.status = "active";
    campaign.rate_limited_until = null;
  }

  const runRow = run as BlueskyFollowCampaignRunRow & {
    already_absent_count?: number;
  };

  // Re-evaluate against what this run has ALREADY done today.
  const live = computeEffectiveUnfollowQuota({
    requested: campaign.requested_daily_quota,
    identityMutationsToday,
    consecutiveFailures: run.consecutive_failures,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    // RESOLVED attempts, not consumed ones. `attempted_count` rises at
    // provider intent — before any response exists — so using it would
    // read a chunk still in flight as a run of total failures and trip
    // the breaker on a healthy campaign.
    resolvedToday: run.succeeded_count + run.failed_count,
    succeededToday: run.succeeded_count,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    // BOTH windows, whichever is later. The run is created fresh each
    // local day and carries no rate-limit state, so consulting only the
    // run would let a campaign rate-limited yesterday evening resume
    // this morning as though nothing had happened — and the provider's
    // reset can easily outlive a local date boundary.
    rateLimitedUntil: laterOf(
      campaign.rate_limited_until,
      run.rate_limited_until,
    ),
    remainingEligible: counts.remainingEligible,
    now,
  });

  if (live.effective <= 0) {
    // AN EXHAUSTED QUOTA DOES NOT MEAN THERE IS NOTHING LEFT TO DO.
    //
    // An unresolved action describes a delete that may have reached a
    // real person's relationship and whose outcome we never learned.
    // Reconciling reads truth and spends nothing, so closing the day
    // here would leave a public ambiguity standing until tomorrow for
    // no reason at all. The reservation RPC hands back reconciliation
    // work regardless of headroom, so the loop is still entered.
    const unresolved = await countUnresolvedCampaignActions({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      db: input.db,
    });
    if (unresolved === 0) {
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
  }

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

  const claimedBy = `unfollow-${now.toISOString()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // ── One dispatcher per campaign-day. Losing the race is a normal
  //    outcome, not an error: another tick already has this campaign.
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
      args,
      input,
      campaign,
      run: runRow,
      session,
      live,
      usageDate,
      claimedBy,
      now,
      out,
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
  input: UnfollowDispatchInput;
  campaign: BlueskyFollowCampaignRow;
  run: BlueskyFollowCampaignRunRow;
  session: Awaited<ReturnType<typeof resolveRelationshipSession>> & { ok: true };
  live: { effective: number };
  usageDate: string;
  claimedBy: string;
  now: Date;
  out: RunCampaignResult;
}): Promise<RunCampaignResult> {
  const { args, input, campaign, live, usageDate, claimedBy, now, out } = ctx;
  // Carried across chunks: a chunk that refreshes hands the renewed
  // session back and the next chunk starts from it.
  let session = ctx.session;
  const run = ctx.run;
  let consecutive = run.consecutive_failures;
  let stop: NextAction | null = null;
  let lastReason: ReservationReason = "queue_empty";

  /**
   * Members this pass has already handled.
   *
   * A reconciliation takeover claims a member REGARDLESS of quota, and
   * the member's backoff is written by the worker from the instant the
   * tick is working from. If that instant and the database's `now()`
   * ever disagree — a clock skew, a replayed tick, a test driving an
   * injected clock — the same member can be handed back immediately and
   * the pass spins on it until its budget runs out, while the healthy
   * queue behind it never moves.
   *
   * The backoff is the primary defence and is asserted separately —
   * and since it is now written in PostgreSQL's own clock, the two
   * clocks in question no longer have to agree for it to hold.
   *
   * This guard is the one that does not depend on the backoff being
   * correct at all: a pass simply never works the same member twice. A
   * mutation control confirmed it is currently unreachable, which is
   * the point — it is the floor under a defence, not the defence.
   */
  const handledThisPass = new Set<string>();

  while (args.remainingBudgetMs() > 0) {
    const reservation = await reserveAndClaim({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      runId: run.id,
      operatorAccountId: campaign.operator_account_id,
      usageDate,
      requested: live.effective,
      identityCeiling: IDENTITY_DAILY_MUTATION_CEILING,
      chunkSize: UNFOLLOW_CHUNK_SIZE,
      leaseSeconds: LEASE_SECONDS,
      claimedBy,
      db: input.db,
    });

    lastReason = reservation.reason;
    if (reservation.reserved === 0 && reservation.reason !== "reconcile") {
      // Nothing reserved and no reconciliation handed back. WHY decides
      // what happens after the loop.
      if (!reservation.reservationId) break;
    }
    if (!reservation.reservationId) break;
    if (reservation.members.length === 0) break;

    // Nothing new. Hand the reservation back and stop rather than
    // re-reading the same profiles for the rest of the budget.
    if (reservation.members.every((m) => handledThisPass.has(m.id))) {
      await applyRunOutcome({
        workspaceId: campaign.workspace_id,
        campaignId: campaign.id,
        runId: run.id,
        operatorAccountId: campaign.operator_account_id,
        usageDate,
        reservationId: reservation.reservationId,
        consecutiveFailures: consecutive,
        db: input.db,
      });
      break;
    }
    for (const m of reservation.members) handledThisPass.add(m.id);

    const chunk = await processUnfollowChunk({
      campaign,
      runId: run.id,
      session,
      members: reservation.members,
      reservationId: reservation.reservationId,
      // A `reconcile` takeover reserves ZERO units and hands back
      // members anyway. Passing the member count as the quota would let
      // a reconciliation pass fund a delete; passing the reservation's
      // own count means the consume call is the only thing that can,
      // and a zero-unit reservation has nothing to spend.
      quotaRemaining: reservation.reserved,
      reconciliationOnly: reservation.reason === "reconcile",
      consecutiveFailures: consecutive,
      claimedBy,
      initiatedBy: campaign.created_by,
      now,
      currentTime: input.currentTime,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
      db: input.db,
      sleep: input.sleep,
      interRequestMs: input.interRequestMs,
    });

    out.ranChunks += 1;
    session = chunk.session;
    consecutive = chunk.consecutiveFailures;
    out.attempted += chunk.attempted;
    out.succeeded += chunk.succeeded;
    out.alreadyNotFollowing += chunk.alreadyNotFollowing;
    out.protectedCount += chunk.protectedCount;
    out.conflicts += chunk.conflicts;
    out.skipped += chunk.skipped;
    out.failed += chunk.failed;

    // No chunk totals are sent. Settlement folds the attempt LEDGER —
    // the rows the worker wrote as it went — so a chunk that ended in a
    // crash and one that ended normally are recovered by the same path.
    // The in-memory numbers above are this tick's report to the
    // operator, and are not what the day's books are built from.
    await applyRunOutcome({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      runId: run.id,
      operatorAccountId: campaign.operator_account_id,
      usageDate,
      reservationId: reservation.reservationId,
      consecutiveFailures: consecutive,
      rateLimitedUntil:
        chunk.next.kind === "stop_run" && chunk.next.resumeAfter
          ? chunk.next.resumeAfter.toISOString()
          : chunk.next.kind === "stop_campaign" &&
              chunk.next.campaignStatus === "rate_limited"
            ? (chunk.rateLimit?.resetAt != null
                ? new Date(chunk.rateLimit.resetAt * 1000).toISOString()
                : null)
            : null,
      rateLimitRemaining: chunk.rateLimit?.remaining ?? null,
      rateLimitResetAt:
        chunk.rateLimit?.resetAt != null
          ? new Date(chunk.rateLimit.resetAt * 1000).toISOString()
          : null,
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
      // `failed` is for a STRUCTURAL stop only. An auth stop is
      // recoverable and is paused with its reason, which the recovery
      // path above looks for.
      status:
        stop.campaignStatus === "rate_limited"
          ? "rate_limited"
          : stop.campaignStatus === "reauthorization_required"
            ? "paused"
            : "failed",
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
      // would make the campaign due immediately: every tick would
      // re-read it, find the run still rate-limited, and burn a
      // dispatcher pass doing nothing until the reset finally elapsed.
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
        // A state the operator can see on the campaign page, rather
        // than a fact buried on today's run row. The dispatcher lists
        // this status, so it remains reachable.
        status: "rate_limited",
        rateLimitedUntil: resumeAfter.toISOString(),
        nextRunAt: retryAt.toISOString(),
        expectedStatuses: ["active", "rate_limited"],
        db: input.db,
      });
    }
    out.note = stop.reason;
    return out;
  }

  const after = await countMembersByStatus({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    db: input.db,
  });
  if (after.remainingEligible === 0) {
    await finishRun(campaign, run, input.db, "queue exhausted", now);
    out.note = (await completeCampaign(campaign, input.db, now))
      ? "campaign completed"
      : "queue exhausted, but work is still outstanding — not completed";
    return out;
  }

  if (lastReason === "quota_exhausted" || lastReason === "identity_exhausted") {
    const reason =
      lastReason === "identity_exhausted"
        ? "this account's daily action limit is reached"
        : "daily quota reached";

    const unresolved = await countUnresolvedCampaignActions({
      workspaceId: campaign.workspace_id,
      campaignId: campaign.id,
      db: input.db,
    });
    if (unresolved > 0) {
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
        }).toISOString(),
        expectedStatuses: ["active"],
        db: input.db,
      });
      out.note = `${reason}; ${unresolved} action(s) still awaiting reconciliation`;
      return out;
    }

    await finishRun(campaign, run, input.db, reason, now);
    out.note = `${reason} (${out.succeeded} unfollowed this pass)`;
    return out;
  }

  // `queue_empty` with members still eligible means every remaining row
  // is leased by someone else or waiting on a backoff. Leave the run
  // open; the next tick picks them up.
  out.note = out.note ?? `stopped: ${lastReason}`;
  return out;
}

/** Close the day's run and schedule the next local day. */
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
  // The NEXT local day, not the next window slot today. Today's quota
  // is spent, so pointing at "five minutes from now" would have the
  // dispatcher reconsider this campaign on every tick for the rest of
  // the day — roughly 288 wake-ups to conclude the same thing.
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
 * produce "2026-09-32" at a month boundary and be wrong on a DST day
 * where the local day is 23 or 25 hours long.
 */
function nextLocalDate(instant: Date, timezone: string): string {
  return localClockAt(new Date(instant.getTime() + 24 * 60 * 60_000), timezone)
    .localDate;
}

/**
 * Mark a campaign completed — exactly once.
 *
 * `expectedStatuses` is a compare-and-set: two workers reaching the last
 * member together both call this, and only one update matches
 * `status = 'active'`.
 */
async function completeCampaign(
  campaign: BlueskyFollowCampaignRow,
  db: SupabaseClient | undefined,
  now: Date,
): Promise<boolean> {
  // The completion guard: nothing actionable AND no outstanding lease,
  // reservation, intent or unresolved action, as the database sees it.
  const may = await campaignMayComplete({
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    db,
  });
  if (!may) return false;
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
