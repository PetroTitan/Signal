import "server-only";
/**
 * Everything the unfollow campaign detail page shows.
 *
 * DELIBERATELY CHEAP. A campaign may hold 100,000 members and this is
 * one page: every number comes from an exact `count(*) head` or from
 * the day's run row, so the cost does not grow with the queue. There is
 * no function here that returns "all members", and no call site that
 * could ask for one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMembersByStatus,
  getCampaign,
  getIdentityUsage,
  getRunForLocalDate,
  listMembersPage,
} from "@/repositories/bluesky-campaign-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";
import { localClockAt } from "@/core/bluesky-campaigns/campaign-day";
import {
  computeEffectiveUnfollowQuota,
  estimateDays,
  IDENTITY_DAILY_MUTATION_CEILING,
  PROVIDER_POINTS,
} from "./quota";
import type { BlueskyCampaignStatus } from "@/lib/supabase/types";

export interface UnfollowMemberRow {
  id: string;
  subjectDid: string;
  handle: string | null;
  status: string;
  protectedReason: string | null;
  recordRkey: string | null;
  recordSource: string | null;
  lastErrorMessage: string | null;
  completedAt: string | null;
}

export interface UnfollowCampaignDetail {
  id: string;
  name: string;
  status: BlueskyCampaignStatus;
  dryRun: boolean;
  /** The Bluesky identity every deletion is performed as. */
  identityLabel: string;
  identityHandle: string | null;
  identityId: string;

  sourceLabel: string;
  sourceFrozen: boolean;
  queueSize: number;

  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  timezone: string;
  windowLabel: string;

  /** Today, from the run row. */
  todayAttempted: number;
  todaySucceeded: number;
  todayAlreadyAbsent: number;
  todayProtected: number;
  todayFailed: number;
  todayReconciliationRequired: number;

  /** Totals across the whole campaign. */
  succeeded: number;
  alreadyNotFollowing: number;
  protectedCount: number;
  failed: number;
  cancelled: number;
  remaining: number;
  total: number;

  lastSuccessAt: string | null;
  nextRunAt: string | null;
  rateLimitedUntil: string | null;
  lastErrorMessage: string | null;

  /** Identity-wide, shared with any follow campaign on this account. */
  identityMutationsToday: number;
  identityCeiling: number;
  identityPointsToday: number;

  estimatedDays: number | null;
  members: UnfollowMemberRow[];
  memberPage: { page: number; pageSize: number; total: number; totalPages: number };
}

const SOURCE_LABELS: Record<string, string> = {
  following_records: "Everyone this account currently follows",
  target_followers: "An imported list",
  follow_campaign: "Profiles a Signal follow campaign followed",
  filtered_candidates: "Your current filtered list",
  candidates: "Your candidate list",
};

function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

export async function loadUnfollowCampaignDetail(input: {
  workspaceId: string;
  campaignId: string;
  page?: number;
  statusFilter?: string | null;
  db?: SupabaseClient;
}): Promise<UnfollowCampaignDetail | null> {
  const campaign = await getCampaign(input.workspaceId, input.campaignId, input.db);
  if (!campaign || campaign.kind !== "unfollow") return null;

  const clock = localClockAt(new Date(), campaign.timezone);
  const usageDate = new Date().toISOString().slice(0, 10);

  const [counts, run, usage, accounts, job, membersPage] = await Promise.all([
    countMembersByStatus({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      db: input.db,
    }),
    getRunForLocalDate({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      localDate: clock.localDate,
      db: input.db,
    }),
    getIdentityUsage({
      workspaceId: input.workspaceId,
      operatorAccountId: campaign.operator_account_id,
      usageDate,
      db: input.db,
    }),
    listAccountsByPlatform(input.workspaceId, "bluesky"),
    getImportJob({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      db: input.db,
    }).catch(() => null),
    listMembersPage({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      page: input.page ?? 1,
      statuses: input.statusFilter
        ? ([input.statusFilter] as never)
        : undefined,
      db: input.db,
    }),
  ]);

  const identity = accounts.find((a) => a.id === campaign.operator_account_id);
  const identityHandle = identity?.handle ?? null;

  const usageRow = usage as
    | (typeof usage & { unfollows_deleted?: number })
    | null;
  const unfollowsToday = Number(usageRow?.unfollows_deleted ?? 0);
  const followsToday = Number(usage?.follows_created ?? 0);
  const identityMutationsToday = Math.max(
    Number(usage?.attempts_made ?? 0),
    followsToday + unfollowsToday,
  );

  const runRow = run as
    | (typeof run & {
        already_absent_count?: number;
        protected_count?: number;
        reconciliation_required_count?: number;
      })
    | null;

  const quota = computeEffectiveUnfollowQuota({
    requested: campaign.requested_daily_quota,
    identityMutationsToday,
    consecutiveFailures: runRow?.consecutive_failures ?? 0,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    resolvedToday:
      (runRow?.succeeded_count ?? 0) + (runRow?.failed_count ?? 0),
    succeededToday: runRow?.succeeded_count ?? 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until
      ? new Date(campaign.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now: new Date(),
  });

  const jobRow = job as unknown as
    | { sourceKind: string; sourceExhausted: boolean }
    | null;

  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    dryRun: campaign.dry_run,
    identityLabel: identityHandle ? `@${identityHandle}` : "this account",
    identityHandle,
    identityId: campaign.operator_account_id,

    sourceLabel: jobRow
      ? (SOURCE_LABELS[jobRow.sourceKind] ?? jobRow.sourceKind)
      : "Not chosen yet",
    // Frozen once the campaign has left the build states. This is the
    // sentence the confirmation screen made, rendered back as a fact.
    sourceFrozen:
      campaign.status !== "draft" && campaign.status !== "building_queue",
    queueSize: counts.total,

    requestedDailyQuota: campaign.requested_daily_quota,
    effectiveDailyQuota: quota.effective,
    effectiveQuotaReason: quota.reason,
    timezone: campaign.timezone,
    windowLabel: `${hhmm(campaign.execution_window_start_minute)}–${hhmm(
      campaign.execution_window_end_minute,
    )}`,

    todayAttempted: runRow?.attempted_count ?? 0,
    todaySucceeded: runRow?.succeeded_count ?? 0,
    todayAlreadyAbsent: Number(runRow?.already_absent_count ?? 0),
    todayProtected: Number(runRow?.protected_count ?? 0),
    todayFailed: runRow?.failed_count ?? 0,
    todayReconciliationRequired: Number(
      runRow?.reconciliation_required_count ?? 0,
    ),

    succeeded: counts.succeeded,
    alreadyNotFollowing: Number(
      (counts as unknown as { already_not_following?: number })
        .already_not_following ?? 0,
    ),
    protectedCount: counts.protected,
    failed: counts.failed_structural,
    cancelled: counts.cancelled,
    remaining: counts.remainingEligible,
    total: counts.total,

    lastSuccessAt: runRow?.last_chunk_at ?? null,
    nextRunAt: campaign.next_run_at,
    rateLimitedUntil: campaign.rate_limited_until,
    // Provider messages only. No token, header or credential can reach
    // this field — nothing writes one into the columns it reads.
    lastErrorMessage: campaign.last_error_message,

    identityMutationsToday,
    identityCeiling: IDENTITY_DAILY_MUTATION_CEILING,
    identityPointsToday:
      followsToday * PROVIDER_POINTS.create +
      unfollowsToday * PROVIDER_POINTS.delete,

    estimatedDays: estimateDays(counts.remainingEligible, quota.effective),
    members: membersPage.rows.map((m) => {
      const row = m as typeof m & {
        protected_reason?: string | null;
        provider_record_source?: string | null;
      };
      return {
        id: m.id,
        subjectDid: m.subject_did,
        handle: m.current_handle,
        status: m.status,
        protectedReason: row.protected_reason ?? null,
        recordRkey: m.provider_record_rkey,
        recordSource: row.provider_record_source ?? null,
        lastErrorMessage: m.last_error_message,
        completedAt: m.completed_at,
      };
    }),
    memberPage: membersPage.info,
    // `sourceExhausted` is deliberately not exposed as a separate flag:
    // the campaign's own status already carries it, and two sources of
    // truth for "is the list finished" is how a campaign gets activated
    // mid-import.
  };
}
