import "server-only";
/**
 * The one-line answer to "is Signal following anyone for me right now?"
 *
 * Rendered on the main Relationships page, where the operator starts.
 * Automatic following used to be invisible from there — it lived behind
 * a nav entry that was inside the More sheet on mobile — so a campaign
 * could be running, paused or finished without any of that appearing
 * where the work happens.
 *
 * DELIBERATELY CHEAP
 * ------------------
 * Nothing here reads the queue. A campaign may hold 100,000 members and
 * this is a header panel: every number comes from an exact
 * `count(*) head` or from the day's run row, so the cost does not grow
 * with the queue. `loadCampaigns` is the full view and is not used here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMembersByStatus,
  getRunForLocalDate,
  listCampaigns,
} from "@/repositories/bluesky-campaign-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { computeEffectiveQuota, IDENTITY_DAILY_FOLLOW_CEILING } from "./quota";
import { localClockAt } from "./campaign-day";
import { getIdentityUsage } from "@/repositories/bluesky-campaign-repository";
import type { BlueskyCampaignStatus } from "@/lib/supabase/types";

export interface CampaignSummary {
  id: string;
  name: string;
  status: BlueskyCampaignStatus;
  identityHandle: string | null;
  identityDisplayName: string | null;
  /** Members that have reached a terminal state. */
  completed: number;
  total: number;
  attemptedToday: number;
  succeededToday: number;
  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  nextRunAt: string | null;
  dryRun: boolean;
}

/**
 * The campaign worth showing, if there is one.
 *
 * "Worth showing" is the most live one: an active or rate-limited
 * campaign outranks a paused one, which outranks a finished one. A
 * draft is not shown — it is not doing anything, and the CTA already
 * leads to setup.
 */
const LIVENESS: Record<string, number> = {
  active: 0,
  rate_limited: 1,
  reauthorization_required: 2,
  paused: 3,
  failed: 4,
  completed: 5,
  cancelled: 6,
};

export async function loadCampaignSummary(input: {
  workspaceId: string;
  now?: Date;
  db?: SupabaseClient;
}): Promise<CampaignSummary | null> {
  const now = input.now ?? new Date();

  let campaigns;
  try {
    campaigns = await listCampaigns(input.workspaceId, 50, input.db);
  } catch {
    // The panel is an aside. A read failure here must not take down the
    // page an operator uses to work manually — the campaigns page
    // itself reports the failure properly.
    return null;
  }

  const live = campaigns
    .filter((c) => c.status !== "draft" && c.status in LIVENESS)
    .sort((a, b) => (LIVENESS[a.status] ?? 9) - (LIVENESS[b.status] ?? 9))[0];
  if (!live) return null;

  const accounts = await listAccountsByPlatform(input.workspaceId, "bluesky");
  const identity = accounts.find(
    (a: { id: string }) => a.id === live.operator_account_id,
  );

  const clock = localClockAt(now, live.timezone);
  const [counts, today, usage] = await Promise.all([
    countMembersByStatus({
      workspaceId: input.workspaceId,
      campaignId: live.id,
      db: input.db,
    }),
    getRunForLocalDate({
      workspaceId: input.workspaceId,
      campaignId: live.id,
      localDate: clock.localDate,
      db: input.db,
    }),
    getIdentityUsage({
      workspaceId: input.workspaceId,
      operatorAccountId: live.operator_account_id,
      usageDate: now.toISOString().slice(0, 10),
      db: input.db,
    }),
  ]);

  // What Signal may attempt today, which is never more than what was
  // asked for and is often less.
  const quota = computeEffectiveQuota({
    requested: live.requested_daily_quota,
    identityFollowsToday: usage?.follows_created ?? 0,
    consecutiveFailures: today?.consecutive_failures ?? 0,
    maxConsecutiveFailures: live.max_consecutive_failures,
    attemptedToday: (today?.succeeded_count ?? 0) + (today?.failed_count ?? 0),
    succeededToday: today?.succeeded_count ?? 0,
    minSuccessRatePercent: live.min_success_rate_percent,
    rateLimitedUntil: live.rate_limited_until
      ? new Date(live.rate_limited_until)
      : null,
    remainingEligible: counts.remainingEligible,
    now,
  });

  return {
    id: live.id,
    name: live.name,
    status: live.status,
    identityHandle: identity?.handle ?? null,
    identityDisplayName: identity?.displayName ?? null,
    completed: counts.total - counts.remainingEligible,
    total: counts.total,
    attemptedToday: today?.attempted_count ?? 0,
    succeededToday: today?.succeeded_count ?? 0,
    requestedDailyQuota: live.requested_daily_quota,
    effectiveDailyQuota: quota.effective,
    effectiveQuotaReason: quota.reason,
    nextRunAt: live.next_run_at,
    dryRun: live.dry_run,
  };
}
