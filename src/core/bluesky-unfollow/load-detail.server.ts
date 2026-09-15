import "server-only";
/**
 * Everything the unfollow campaign detail page shows.
 *
 * DELIBERATELY CHEAP. A campaign may hold 100,000 members and this is
 * one page: every number comes from an exact `count(*) head` or from a
 * run row, so the cost does not grow with the queue. There is no
 * function here that returns "all members", and no call site that
 * could ask for one. The member list and the run history are KEYSET
 * pages — a page taken while the dispatcher moves rows never skips or
 * repeats one.
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 * An operational dashboard for a campaign that already exists: what it
 * is, what it has done, what it will do next, and the controls to
 * change that. It is not a setup form. Nothing here is an input that
 * pretends to edit a created campaign.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMembersByStatus,
  countReconcilingActions,
  countSkipReasons,
  getCampaign,
  getIdentityUsage,
  getRunForLocalDate,
  listMembersKeyset,
  listRunsKeyset,
} from "@/repositories/bluesky-campaign-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";
import { getTargetProfile } from "@/repositories/bluesky-relationship-repository";
import { listAllowlist } from "@/repositories/bluesky-unfollow-repository";
import { formatMinutes, localClockAt } from "@/core/bluesky-campaigns/campaign-day";
import {
  computeEffectiveUnfollowQuota,
  estimateDays,
  IDENTITY_DAILY_MUTATION_CEILING,
  PROVIDER_POINTS,
} from "./quota";
import { UNFOLLOW_SOURCE_LABELS } from "./activation-facts.server";
import type {
  BlueskyCampaignMemberStatus,
  BlueskyCampaignStatus,
  BlueskyFollowCampaignRunRow,
} from "@/lib/supabase/types";

/**
 * The closed vocabulary of reasons, in the operator's words. A code
 * outside this map is shown as the code itself — still a closed value
 * written by the worker, never free text from the provider.
 */
export const MEMBER_REASON_LABELS: Record<string, string> = {
  dry_run: "Simulated (dry run) — nothing was sent to Bluesky.",
  actor_not_found: "Account not found on Bluesky.",
  ineligible: "Not eligible when reached.",
  protected: "Protected — on the never-unfollow list or excluded on purpose.",
  conflict: "The stored follow record no longer matched Bluesky; nothing was deleted.",
  no_record_target: "No follow record to delete.",
  blocked: "Blocked.",
  self: "This is the acting account itself.",
  invalid: "Bluesky rejected the request as invalid.",
};

export interface UnfollowMemberRow {
  id: string;
  sequence: number;
  subjectDid: string;
  handle: string | null;
  status: string;
  /** True when this outcome was produced by a dry run — nothing was sent. */
  simulated: boolean;
  /** The closed reason code, when the member is terminal for a reason. */
  reasonCode: string | null;
  /** The reason in the operator's words. */
  reasonLabel: string | null;
  protectedReason: string | null;
  recordRkey: string | null;
  recordSource: string | null;
  lastErrorMessage: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  completedAt: string | null;
}

export interface UnfollowRunSummary {
  id: string;
  localDate: string;
  status: string;
  attempted: number;
  succeeded: number;
  alreadyAbsent: number;
  protectedCount: number;
  failed: number;
  reconciliationRequired: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  lastChunkAt: string | null;
  lastErrorMessage: string | null;
}

export interface UnfollowCampaignDetail {
  id: string;
  kind: "unfollow";
  name: string;
  status: BlueskyCampaignStatus;
  dryRun: boolean;
  /** The Bluesky identity every deletion is performed as. */
  identityLabel: string;
  identityHandle: string | null;
  identityId: string;

  /** Exactly what the import job persisted. */
  sourceKind: string;
  sourceLabel: string;
  sourceTargetLabel: string | null;
  sourceFrozen: boolean;
  queueSize: number;
  allowlistCount: number;

  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  timezone: string;
  windowLabel: string;
  windowStartMinute: number;
  windowEndMinute: number;

  /** Today, from the run row. */
  todayAttempted: number;
  todaySucceeded: number;
  todayAlreadyAbsent: number;
  todayProtected: number;
  todayFailed: number;
  todayReconciliationRequired: number;

  /** Totals across the whole campaign — every member is in exactly one. */
  queued: number;
  /** Claimed or running right now. */
  inProgress: number;
  /** Reached at least once: total − queued − in progress − cancelled. */
  processed: number;
  succeeded: number;
  alreadyNotFollowing: number;
  protectedCount: number;
  /** Waiting for a real retry (transient error, backoff). */
  retrying: number;
  /** Waiting for a READ to settle an unknown outcome. Never re-sent. */
  reconciling: number;
  failed: number;
  /** Dry-run outcomes: went through every step, sent nothing. */
  simulated: number;
  /** Other terminal skips, by closed reason code. */
  skippedByReason: Record<string, number>;
  cancelled: number;
  remaining: number;
  total: number;
  progressPercent: number;

  lastSuccessAt: string | null;
  nextRunAt: string | null;
  rateLimitedUntil: string | null;
  lastErrorMessage: string | null;

  /** Identity-wide, shared with any follow campaign on this account. */
  identityFollowsToday: number;
  identityUnfollowsToday: number;
  identityMutationsToday: number;
  identityCeiling: number;
  identityPointsToday: number;

  estimatedDays: number | null;
  /** The most recent run, whatever its date. */
  latestRun: UnfollowRunSummary | null;
  runs: UnfollowRunSummary[];
  runsNextCursor: string | null;
  members: UnfollowMemberRow[];
  membersNextCursor: number | null;
  memberFilter: string | null;
}

const MEMBER_STATUSES = new Set<string>([
  "queued", "claimed", "running", "succeeded", "already_following",
  "already_not_following", "protected", "skipped", "retryable",
  "failed_structural", "cancelled",
]);

/**
 * A `date` column as YYYY-MM-DD. PostgREST returns the string; a
 * PostgreSQL driver returns a JS Date at UTC midnight. Both must become
 * the same ten characters, or a cursor built from one would not match
 * the other.
 */
export function localDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function runSummary(r: BlueskyFollowCampaignRunRow): UnfollowRunSummary {
  const row = r as BlueskyFollowCampaignRunRow & {
    already_absent_count?: number;
    protected_count?: number;
    reconciliation_required_count?: number;
    effective_quota_reason?: string | null;
  };
  return {
    id: r.id,
    localDate: localDateString(r.local_date),
    status: r.status,
    attempted: Number(r.attempted_count ?? 0),
    succeeded: Number(r.succeeded_count ?? 0),
    alreadyAbsent: Number(row.already_absent_count ?? 0),
    protectedCount: Number(row.protected_count ?? 0),
    failed: Number(r.failed_count ?? 0),
    reconciliationRequired: Number(row.reconciliation_required_count ?? 0),
    effectiveDailyQuota: Number(r.effective_daily_quota ?? 0),
    effectiveQuotaReason: row.effective_quota_reason ?? null,
    lastChunkAt: r.last_chunk_at ?? null,
    lastErrorMessage: r.last_error_message ?? null,
  };
}

export async function loadUnfollowCampaignDetail(input: {
  workspaceId: string;
  campaignId: string;
  /** Member keyset cursor: show members with import_sequence > this. */
  afterSequence?: number | null;
  statusFilter?: string | null;
  /** Run keyset cursor: show runs before this local date. */
  runsBefore?: string | null;
  now?: Date;
  db?: SupabaseClient;
}): Promise<UnfollowCampaignDetail | null> {
  const campaign = await getCampaign(input.workspaceId, input.campaignId, input.db);
  if (!campaign || campaign.kind !== "unfollow") return null;

  const now = input.now ?? new Date();
  const clock = localClockAt(now, campaign.timezone);
  const usageDate = now.toISOString().slice(0, 10);
  const statusFilter =
    input.statusFilter && MEMBER_STATUSES.has(input.statusFilter) ? input.statusFilter : null;

  const [counts, run, usage, accounts, job, membersPage, runsPage, reconciling, skipReasons, allowlist] =
    await Promise.all([
      countMembersByStatus({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }),
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
      listAccountsByPlatform(input.workspaceId, "bluesky", input.db),
      getImportJob({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }).catch(
        () => null,
      ),
      listMembersKeyset({
        workspaceId: input.workspaceId,
        campaignId: campaign.id,
        afterSequence: input.afterSequence ?? null,
        statuses: statusFilter ? [statusFilter as BlueskyCampaignMemberStatus] : undefined,
        db: input.db,
      }),
      listRunsKeyset({
        workspaceId: input.workspaceId,
        campaignId: campaign.id,
        beforeLocalDate: input.runsBefore ?? null,
        pageSize: 10,
        db: input.db,
      }),
      countReconcilingActions({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }),
      countSkipReasons({ workspaceId: input.workspaceId, campaignId: campaign.id, db: input.db }),
      listAllowlist({ workspaceId: input.workspaceId, db: input.db }),
    ]);

  const identity = accounts.find((a) => a.id === campaign.operator_account_id);
  const identityHandle = identity?.handle ?? null;

  const targetLabel =
    job?.targetProfileId
      ? await getTargetProfile(input.workspaceId, job.targetProfileId, input.db)
          .then((t) => (t?.handle ? `@${String(t.handle).replace(/^@+/, "")}` : null))
          .catch(() => null)
      : null;

  const usageRow = usage as (typeof usage & { unfollows_deleted?: number }) | null;
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
    resolvedToday: (runRow?.succeeded_count ?? 0) + (runRow?.failed_count ?? 0),
    succeededToday: runRow?.succeeded_count ?? 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until ? new Date(campaign.rate_limited_until) : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  const alreadyNotFollowing = Number(
    (counts as unknown as { already_not_following?: number }).already_not_following ?? 0,
  );
  const simulated = Number(skipReasons.dry_run ?? 0);
  const skippedByReason: Record<string, number> = {};
  for (const [code, n] of Object.entries(skipReasons)) {
    if (code === "dry_run" || code === "protected") continue;
    skippedByReason[code] = Number(n);
  }
  const inProgress = counts.claimed + counts.running;
  const processed = Math.max(0, counts.total - counts.queued - inProgress - counts.cancelled);
  const retrying = Math.max(0, counts.retryable - reconciling);
  const progressPercent =
    counts.total > 0
      ? Math.min(100, Math.round(((counts.total - counts.remainingEligible) / counts.total) * 100))
      : 0;

  const runs = runsPage.rows.map(runSummary);
  const latestRun =
    !input.runsBefore && runs.length > 0
      ? runs[0]
      : run
        ? runSummary(run)
        : runs[0] ?? null;

  const allowlistCount = allowlist.filter(
    (e) => e.operatorAccountId === null || e.operatorAccountId === campaign.operator_account_id,
  ).length;

  return {
    id: campaign.id,
    kind: "unfollow",
    name: campaign.name,
    status: campaign.status,
    dryRun: campaign.dry_run,
    identityLabel: identityHandle ? `@${identityHandle.replace(/^@+/, "")}` : "this account",
    identityHandle,
    identityId: campaign.operator_account_id,

    sourceKind: job?.sourceKind ?? "unknown",
    sourceLabel: job ? (UNFOLLOW_SOURCE_LABELS[job.sourceKind] ?? job.sourceKind) : "Not chosen yet",
    sourceTargetLabel: targetLabel,
    // Frozen once the campaign has left the build states.
    sourceFrozen: campaign.status !== "draft" && campaign.status !== "building_queue",
    queueSize: counts.total,
    allowlistCount,

    requestedDailyQuota: campaign.requested_daily_quota,
    effectiveDailyQuota: quota.effective,
    effectiveQuotaReason: quota.reason,
    timezone: campaign.timezone,
    windowLabel: `${formatMinutes(campaign.execution_window_start_minute)}–${formatMinutes(
      campaign.execution_window_end_minute,
    )}`,
    windowStartMinute: campaign.execution_window_start_minute,
    windowEndMinute: campaign.execution_window_end_minute,

    todayAttempted: runRow?.attempted_count ?? 0,
    todaySucceeded: runRow?.succeeded_count ?? 0,
    todayAlreadyAbsent: Number(runRow?.already_absent_count ?? 0),
    todayProtected: Number(runRow?.protected_count ?? 0),
    todayFailed: runRow?.failed_count ?? 0,
    todayReconciliationRequired: Number(runRow?.reconciliation_required_count ?? 0),

    queued: counts.queued,
    inProgress,
    processed,
    succeeded: counts.succeeded,
    alreadyNotFollowing,
    protectedCount: counts.protected,
    retrying,
    reconciling,
    failed: counts.failed_structural,
    simulated,
    skippedByReason,
    cancelled: counts.cancelled,
    remaining: counts.remainingEligible,
    total: counts.total,
    progressPercent,

    lastSuccessAt: runRow?.last_chunk_at ?? null,
    nextRunAt: campaign.next_run_at,
    rateLimitedUntil: campaign.rate_limited_until,
    // Provider messages only. No token, header or credential can reach
    // this field — nothing writes one into the columns it reads.
    lastErrorMessage: campaign.last_error_message,

    identityFollowsToday: followsToday,
    identityUnfollowsToday: unfollowsToday,
    identityMutationsToday,
    identityCeiling: IDENTITY_DAILY_MUTATION_CEILING,
    identityPointsToday:
      followsToday * PROVIDER_POINTS.create + unfollowsToday * PROVIDER_POINTS.delete,

    estimatedDays: estimateDays(counts.remainingEligible, quota.effective),
    latestRun,
    runs,
    runsNextCursor: runsPage.nextCursor,
    members: membersPage.rows.map((m) => {
      const row = m as typeof m & {
        protected_reason?: string | null;
        provider_record_source?: string | null;
        last_error_code?: string | null;
        next_attempt_at?: string | null;
        attempt_count?: number;
      };
      const code = row.protected_reason ? "protected" : (row.last_error_code ?? null);
      const terminalForReason =
        m.status === "skipped" || m.status === "protected" || m.status === "failed_structural";
      return {
        id: m.id,
        sequence: Number(m.import_sequence),
        subjectDid: m.subject_did,
        handle: m.current_handle,
        status: m.status,
        simulated: row.last_error_code === "dry_run",
        reasonCode: terminalForReason ? code : null,
        reasonLabel: terminalForReason && code
          ? (MEMBER_REASON_LABELS[code] ?? (row.protected_reason ? `Protected: ${row.protected_reason}` : code))
          : null,
        protectedReason: row.protected_reason ?? null,
        recordRkey: m.provider_record_rkey,
        recordSource: row.provider_record_source ?? null,
        lastErrorMessage: m.last_error_message,
        attemptCount: Number(row.attempt_count ?? 0),
        nextAttemptAt: row.next_attempt_at ?? null,
        completedAt: m.completed_at,
      };
    }),
    membersNextCursor: membersPage.nextCursor,
    memberFilter: statusFilter,
  };
}
