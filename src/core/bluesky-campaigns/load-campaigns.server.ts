import "server-only";
/**
 * One loader for the campaign surface.
 *
 * For a 100,000-member campaign this reads: the campaign row, eleven
 * index-only counts, one page of at most 50 members, one page of runs,
 * and today's run. It never reads the queue.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import {
  countMembersByStatus,
  countReconcilingActions,
  countSkipReasons,
  getIdentityUsage,
  listCampaigns,
  listKillSwitches,
  listMembersPage,
  listRunsPage,
  type MemberStatusCounts,
  type PageInfo,
} from "@/repositories/bluesky-campaign-repository";
import type {
  BlueskyCampaignKillSwitchRow,
  BlueskyCampaignMemberStatus,
  BlueskyFollowCampaignMemberRow,
  BlueskyFollowCampaignRow,
  BlueskyFollowCampaignRunRow,
} from "@/lib/supabase/types";
import {
  computeEffectiveQuota,
  estimateCompletionDate,
  IDENTITY_DAILY_FOLLOW_CEILING,
} from "./quota";
import { localClockAt, isWithinWindow, computeNextRunAt } from "./campaign-day";
import { classifyReadFailure } from "@/core/bluesky-relationships/read-failure";
import type { ReadFailure } from "@/core/bluesky-relationships/read-failure";
import { describeFailedCampaign } from "./campaign-recovery";

export interface CampaignDetail {
  campaign: BlueskyFollowCampaignRow;
  counts: MemberStatusCounts;
  members: BlueskyFollowCampaignMemberRow[];
  memberPage: PageInfo;
  runs: BlueskyFollowCampaignRunRow[];
  runPage: PageInfo;
  /** The run for the campaign's CURRENT local date, if any. */
  today: BlueskyFollowCampaignRunRow | null;
  /** What Signal may attempt right now, and why it is what it is. */
  effectiveQuota: { effective: number; reason: string | null; halted: boolean };
  percentComplete: number;
  estimatedCompletion: { date: string; daysRemaining: number } | null;
  localDate: string;
  insideWindow: boolean;
  nextWindowAt: string | null;
  identityFollowsToday: number;
  identityCeiling: number;
  /** The single most useful sentence: what the operator must do next. */
  nextUserAction: string | null;
  lastSuccessAt: string | null;
  /**
   * The frozen queue, in the three groups an operator actually asks
   * about. Sums to `counts.total`, which never shrinks.
   */
  outcomes: CampaignOutcomeBreakdown;
}

export interface CampaignOutcomeBreakdown {
  /** The desired relationship state holds. */
  achieved: { succeeded: number; alreadyFollowing: number };
  /** Following is impossible, and here is exactly why. */
  impossible: {
    actorNotFound: number;
    protected: number;
    failedStructural: number;
    cancelled: number;
    /** Every other closed reason, by code. */
    otherByReason: Record<string, number>;
  };
  /** Still actionable — Signal will keep coming back for these. */
  pending: {
    queued: number;
    leased: number;
    retrying: number;
    reconciling: number;
  };
}

export type CampaignKindFilter = "all" | "follow" | "unfollow";

export interface CampaignsView {
  identities: { id: string; handle: string | null; displayName: string | null }[];
  /** Every campaign of every kind, for the picker; filtered by `kindFilter`. */
  campaigns: BlueskyFollowCampaignRow[];
  kindFilter: CampaignKindFilter;
  /** The FOLLOW campaign shown in detail. Never an unfollow campaign. */
  selected: CampaignDetail | null;
  /**
   * Set when the requested campaign is an UNFOLLOW campaign: the page
   * must send the operator to that campaign's own screen rather than
   * render it inside the follow detail, which is how production showed
   * a setup form with default values under an unfollow campaign.
   */
  redirectTo: string | null;
  killSwitches: BlueskyCampaignKillSwitchRow[];
  failure: ReadFailure | null;
}

export async function loadCampaigns(input: {
  workspaceId: string;
  campaignId?: string | null;
  kind?: CampaignKindFilter | null;
  memberPage?: number;
  memberStatus?: BlueskyCampaignMemberStatus | null;
  runPage?: number;
  now?: Date;
  db?: SupabaseClient;
}): Promise<CampaignsView> {
  const now = input.now ?? new Date();
  const kindFilter: CampaignKindFilter =
    input.kind === "follow" || input.kind === "unfollow" ? input.kind : "all";
  const accounts = await listAccountsByPlatform(input.workspaceId, "bluesky", input.db);
  const identities = accounts.map((a) => ({
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
  }));

  let campaigns: BlueskyFollowCampaignRow[] = [];
  let killSwitches: BlueskyCampaignKillSwitchRow[] = [];
  try {
    [campaigns, killSwitches] = await Promise.all([
      listCampaigns(input.workspaceId, 50, input.db),
      listKillSwitches(input.workspaceId, input.db),
    ]);
  } catch (err) {
    // Classified, not swallowed: a missing table means the migration
    // has not been applied and no retry will help.
    return {
      identities,
      campaigns: [],
      kindFilter,
      selected: null,
      redirectTo: null,
      killSwitches: [],
      failure: classifyReadFailure(err),
    };
  }

  const visible =
    kindFilter === "all" ? campaigns : campaigns.filter((c) => c.kind === kindFilter);

  // An unfollow campaign has its own screen. It is never rendered
  // through the follow detail, whatever the URL asked for.
  const requested = input.campaignId
    ? campaigns.find((c) => c.id === input.campaignId) ?? null
    : null;
  if (requested && requested.kind === "unfollow") {
    return {
      identities,
      campaigns: visible,
      kindFilter,
      selected: null,
      redirectTo: `/relationships/unfollow/${requested.id}`,
      killSwitches,
      failure: null,
    };
  }

  const campaign =
    requested ??
    (kindFilter === "unfollow" ? null : visible.find((c) => c.kind === "follow") ?? null);
  if (!campaign) {
    return { identities, campaigns: visible, kindFilter, selected: null, redirectTo: null, killSwitches, failure: null };
  }

  const clock = localClockAt(now, campaign.timezone);
  const window = {
    startMinute: campaign.execution_window_start_minute,
    endMinute: campaign.execution_window_end_minute,
  };

  const [counts, memberPage, runPage, usage] = await Promise.all([
    countMembersByStatus({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      db: input.db,
    }),
    listMembersPage({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      statuses: input.memberStatus ? [input.memberStatus] : undefined,
      page: input.memberPage,
      db: input.db,
    }),
    listRunsPage({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      page: input.runPage,
      db: input.db,
    }),
    getIdentityUsage({
      workspaceId: input.workspaceId,
      operatorAccountId: campaign.operator_account_id,
      usageDate: now.toISOString().slice(0, 10),
      db: input.db,
    }),
  ]);

  const today =
    runPage.rows.find((r) => r.local_date === clock.localDate) ?? null;

  const [skipReasons, reconciling] = await Promise.all([
    countSkipReasons({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }),
    countReconcilingActions({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }),
  ]);
  const reason = (k: string) => skipReasons[k] ?? 0;
  const otherByReason: Record<string, number> = { ...skipReasons };
  for (const k of ["actor_not_found", "ineligible", "protected"]) delete otherByReason[k];
  const outcomes: CampaignOutcomeBreakdown = {
    achieved: {
      succeeded: counts.succeeded,
      alreadyFollowing: counts.already_following,
    },
    impossible: {
      actorNotFound: reason("actor_not_found"),
      protected: counts.protected + reason("ineligible"),
      failedStructural: counts.failed_structural,
      cancelled: counts.cancelled,
      otherByReason,
    },
    pending: {
      queued: counts.queued,
      leased: counts.claimed + counts.running,
      // A retryable member with a reconciling action is waiting on a
      // READ, not on a retry. Shown apart because the operator should
      // know nothing more will be sent for it until Bluesky answers.
      retrying: Math.max(0, counts.retryable - reconciling),
      reconciling: Math.min(counts.retryable, reconciling),
    },
  };

  const effectiveQuota = computeEffectiveQuota({
    requested: campaign.requested_daily_quota,
    identityFollowsToday: usage?.follows_created ?? 0,
    consecutiveFailures: today?.consecutive_failures ?? 0,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    attemptedToday: today?.attempted_count ?? 0,
    succeededToday: today?.succeeded_count ?? 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until
      ? new Date(campaign.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  // Progress is measured against what is DONE, not what was attempted.
  const done =
    counts.succeeded +
    counts.already_following +
    counts.skipped +
    counts.protected +
    counts.failed_structural +
    counts.cancelled;
  const percentComplete =
    counts.total === 0 ? 0 : Math.floor((done / counts.total) * 100);

  // Projected from observed SUCCESSES per completed run, never from an
  // assumed quota — a campaign that has never run gets no date at all.
  const completedRuns = runPage.rows.filter((r) => r.status === "completed");
  const observed =
    completedRuns.length > 0
      ? Math.round(
          completedRuns.reduce((sum, r) => sum + r.succeeded_count, 0) /
            completedRuns.length,
        )
      : null;
  const estimate = estimateCompletionDate({
    remainingEligible: counts.remainingEligible,
    observedDailySuccesses: observed,
    from: now,
  });

  const insideWindow = isWithinWindow(now, campaign.timezone, window);

  return {
    identities,
    campaigns: visible,
    kindFilter,
    redirectTo: null,
    killSwitches,
    failure: null,
    selected: {
      campaign,
      counts,
      members: memberPage.rows,
      memberPage: memberPage.info,
      runs: runPage.rows,
      runPage: runPage.info,
      today,
      effectiveQuota,
      percentComplete,
      estimatedCompletion: estimate
        ? {
            date: estimate.date.toISOString().slice(0, 10),
            daysRemaining: estimate.daysRemaining,
          }
        : null,
      localDate: clock.localDate,
      insideWindow,
      nextWindowAt: insideWindow
        ? null
        : computeNextRunAt({
            from: now,
            timezone: campaign.timezone,
            window,
            notBeforeLocalDate: campaign.start_date,
          }).toISOString(),
      identityFollowsToday: usage?.follows_created ?? 0,
      identityCeiling: IDENTITY_DAILY_FOLLOW_CEILING,
      nextUserAction: describeNextAction(campaign, counts, effectiveQuota, today),
      lastSuccessAt:
        runPage.rows.find((r) => r.succeeded_count > 0)?.last_chunk_at ?? null,
      outcomes,
    },
  };
}

/**
 * The one sentence an operator most needs.
 *
 * Returns null when nothing is required — an active campaign inside its
 * window needs no instruction, and inventing one would train operators
 * to ignore this field.
 */
function describeNextAction(
  campaign: BlueskyFollowCampaignRow,
  counts: MemberStatusCounts,
  quota: { effective: number; reason: string | null; halted: boolean },
  today: BlueskyFollowCampaignRunRow | null = null,
): string | null {
  // An ACTIVE campaign whose run for today is paused for a recoverable
  // reason is waiting on the operator, and must say so — the deployed
  // page said "active" over a day in which nothing would happen.
  if (
    campaign.status === "active" &&
    today &&
    (today.status === "paused" || today.status === "failed") &&
    today.last_error_code === "reauthorization_required"
  ) {
    return "Sign in to this Bluesky identity again on Accounts. Signal resumes today's run automatically once the session works — no need to press Resume.";
  }
  switch (campaign.status) {
    case "draft":
      return counts.total === 0
        ? "Import profiles into the queue, then activate."
        : "Review the configuration and activate when you are ready.";
    case "reauthorization_required":
      return "Sign in to this Bluesky identity again on Accounts. Signal checks on its next tick and resumes the campaign — and today's run — automatically.";
    case "failed":
      return describeFailedCampaign({
        errorCode: campaign.last_error_code,
        errorMessage: campaign.last_error_message,
      });
    case "rate_limited":
      return campaign.rate_limited_until
        ? `Bluesky rate-limited this account. Nothing will be attempted before ${campaign.rate_limited_until}. No action needed.`
        : "Bluesky rate-limited this account. It will resume on its own.";
    case "paused":
      return "Paused. Resume when you are ready — the queue position is unchanged.";
    case "completed":
    case "cancelled":
      return null;
    case "active":
      if (counts.remainingEligible === 0) {
        return "Every profile has been processed. The campaign will close on its next run.";
      }
      return quota.halted ? quota.reason : null;
    // Build states. Reachable only for unfollow campaigns, which have
    // their own view — this loader serves the follow list and simply
    // has nothing to instruct here. The cases are listed rather than
    // defaulted so a status added later is a compile error, not a
    // silent null.
    case "building_queue":
      return "The list of profiles is still being built.";
    case "ready":
      return "The list is complete. Start it when you are ready.";
  }
}
