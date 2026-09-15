import "server-only";
/**
 * What the operator is asked to confirm before automatic unfollowing
 * starts — read from the PERSISTED campaign and its FROZEN queue, and
 * fingerprinted so activation can prove it is starting the campaign
 * the operator actually reviewed.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The confirmation dialog was built from the setup wizard's React state:
 * the quota, time zone, window and dry-run flag were whatever the form
 * fields held at the moment the button was pressed. The campaign row
 * had been written earlier, at "start". Production persisted a campaign
 * with a 00:00–01:00 UTC window and showed a dialog saying 09:00–20:00
 * UTC — the form's defaults. For a campaign that deletes public
 * relationships, a confirmation that describes a different schedule is
 * not a confirmation.
 *
 * Nothing here comes from the client. The dialog renders exactly this
 * object, and activation reloads it and compares `version`s: if the
 * quota, source, identity, dry-run flag, queue size, time zone, window,
 * allowlist or protected count changed between review and submit, the
 * activation is refused and the operator reviews again.
 *
 * DELIBERATELY CHEAP. Counts are index-only `count(*)`; no member row
 * is read.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMembersByStatus,
  getCampaign,
  getIdentityUsage,
  getRunForLocalDate,
} from "@/repositories/bluesky-campaign-repository";
import { listAllowlist } from "@/repositories/bluesky-unfollow-repository";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { formatMinutes, localClockAt } from "@/core/bluesky-campaigns/campaign-day";
import { computeEffectiveUnfollowQuota, estimateDays } from "./quota";
import { canonicalConfirmationHandle } from "./confirm-handle";

/** Human labels for the persisted source kinds. */
export const UNFOLLOW_SOURCE_LABELS: Record<string, string> = {
  following_records: "Everyone this account currently follows",
  target_followers: "An imported list",
  follow_campaign: "Profiles a Signal follow campaign followed",
  filtered_candidates: "Your current filtered list",
  candidates: "Your candidate list",
};

export interface UnfollowActivationFacts {
  campaignId: string;
  campaignName: string;
  /** The identity the deletions are performed as. */
  operatorAccountId: string;
  actorLabel: string;
  /** Canonical, no `@`; null when the identity has no usable handle. */
  actorHandle: string | null;
  /** Exactly what the import job persisted. */
  sourceKind: string;
  sourceLabel: string;
  sourceTargetProfileId: string | null;
  /** Null until the import job exists. */
  discovered: number | null;
  stillBuilding: boolean;
  protectedExcluded: number;
  remainingEligible: number;
  allowlistCount: number;
  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  timezone: string;
  windowStartMinute: number;
  windowEndMinute: number;
  windowLabel: string;
  estimatedDays: number | null;
  dryRun: boolean;
  /** Fingerprint of every fact a confirmation is a consent to. */
  version: string;
}

/**
 * The facts a consent covers, in a fixed shape. Anything not in this
 * list may change between review and submit without invalidating the
 * confirmation (the effective quota for TODAY, for instance, moves as
 * the identity is used and is displayed as an estimate).
 */
export function activationFactsVersion(facts: {
  campaignId: string;
  operatorAccountId: string;
  sourceKind: string;
  sourceTargetProfileId: string | null;
  discovered: number | null;
  protectedExcluded: number;
  allowlistCount: number;
  requestedDailyQuota: number;
  timezone: string;
  windowStartMinute: number;
  windowEndMinute: number;
  dryRun: boolean;
}): string {
  const canonical = JSON.stringify([
    "unfollow-activation-v1",
    facts.campaignId,
    facts.operatorAccountId,
    facts.sourceKind,
    facts.sourceTargetProfileId,
    facts.discovered,
    facts.protectedExcluded,
    facts.allowlistCount,
    facts.requestedDailyQuota,
    facts.timezone,
    facts.windowStartMinute,
    facts.windowEndMinute,
    facts.dryRun,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Which confirmed facts differ, in the operator's words. */
export function describeActivationDrift(
  reviewed: UnfollowActivationFacts,
  current: UnfollowActivationFacts,
): string[] {
  const changed: string[] = [];
  if (reviewed.operatorAccountId !== current.operatorAccountId) changed.push("the account it acts as");
  if (
    reviewed.sourceKind !== current.sourceKind ||
    reviewed.sourceTargetProfileId !== current.sourceTargetProfileId
  )
    changed.push("the source list");
  if (reviewed.discovered !== current.discovered) changed.push("the number of profiles");
  if (reviewed.protectedExcluded !== current.protectedExcluded) changed.push("the protected count");
  if (reviewed.allowlistCount !== current.allowlistCount) changed.push("the never-unfollow list");
  if (reviewed.requestedDailyQuota !== current.requestedDailyQuota) changed.push("the daily number");
  if (reviewed.timezone !== current.timezone) changed.push("the time zone");
  if (
    reviewed.windowStartMinute !== current.windowStartMinute ||
    reviewed.windowEndMinute !== current.windowEndMinute
  )
    changed.push("the time of day");
  if (reviewed.dryRun !== current.dryRun) changed.push("whether it is a dry run");
  return changed;
}

export async function loadUnfollowActivationFacts(input: {
  workspaceId: string;
  campaignId: string;
  now?: Date;
  db?: SupabaseClient;
}): Promise<UnfollowActivationFacts | null> {
  const now = input.now ?? new Date();
  const campaign = await getCampaign(input.workspaceId, input.campaignId, input.db);
  if (!campaign || campaign.kind !== "unfollow") return null;

  const clock = localClockAt(now, campaign.timezone);
  const [counts, job, accounts, allowlist, usage, run] = await Promise.all([
    countMembersByStatus({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      db: input.db,
    }),
    getImportJob({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      db: input.db,
    }).catch(() => null),
    listAccountsByPlatform(input.workspaceId, "bluesky", input.db),
    listAllowlist({ workspaceId: input.workspaceId, db: input.db }),
    getIdentityUsage({
      workspaceId: input.workspaceId,
      operatorAccountId: campaign.operator_account_id,
      usageDate: now.toISOString().slice(0, 10),
      db: input.db,
    }),
    getRunForLocalDate({
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      localDate: clock.localDate,
      db: input.db,
    }),
  ]);

  const identity = accounts.find((a) => a.id === campaign.operator_account_id);
  const actorHandle = canonicalConfirmationHandle(identity?.handle);

  // The allowlist entries that apply to THIS identity: entries bound to
  // it, plus workspace-wide ones (no identity).
  const allowlistCount = allowlist.filter(
    (e) =>
      e.operatorAccountId === null ||
      e.operatorAccountId === campaign.operator_account_id,
  ).length;

  const usageRow = usage as (typeof usage & { unfollows_deleted?: number }) | null;
  const identityMutationsToday = Math.max(
    Number(usage?.attempts_made ?? 0),
    Number(usage?.follows_created ?? 0) + Number(usageRow?.unfollows_deleted ?? 0),
  );
  const quota = computeEffectiveUnfollowQuota({
    requested: campaign.requested_daily_quota,
    identityMutationsToday,
    consecutiveFailures: run?.consecutive_failures ?? 0,
    maxConsecutiveFailures: campaign.max_consecutive_failures,
    resolvedToday: (run?.succeeded_count ?? 0) + (run?.failed_count ?? 0),
    succeededToday: run?.succeeded_count ?? 0,
    minSuccessRatePercent: campaign.min_success_rate_percent,
    rateLimitedUntil: campaign.rate_limited_until
      ? new Date(campaign.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  const stillBuilding = !job || (job.status !== "failed" && !job.sourceExhausted);
  const base = {
    campaignId: campaign.id,
    operatorAccountId: campaign.operator_account_id,
    sourceKind: job?.sourceKind ?? "unknown",
    sourceTargetProfileId: job?.targetProfileId ?? null,
    discovered: job ? counts.total : null,
    protectedExcluded: counts.protected,
    allowlistCount,
    requestedDailyQuota: campaign.requested_daily_quota,
    timezone: campaign.timezone,
    windowStartMinute: campaign.execution_window_start_minute,
    windowEndMinute: campaign.execution_window_end_minute,
    dryRun: campaign.dry_run,
  };

  return {
    ...base,
    campaignName: campaign.name,
    actorLabel: actorHandle ? `@${actorHandle}` : "this account",
    actorHandle,
    sourceLabel: job
      ? (UNFOLLOW_SOURCE_LABELS[job.sourceKind] ?? job.sourceKind)
      : "Not chosen yet",
    stillBuilding,
    remainingEligible: counts.remainingEligible,
    effectiveDailyQuota: quota.effective,
    effectiveQuotaReason: quota.reason,
    windowLabel: `${formatMinutes(campaign.execution_window_start_minute)}–${formatMinutes(
      campaign.execution_window_end_minute,
    )}`,
    estimatedDays: estimateDays(counts.remainingEligible, quota.effective),
    version: activationFactsVersion(base),
  };
}
