import "server-only";
/**
 * "What is Signal doing for this identity right now?" — on the main
 * Relationships page, where the operator starts.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The panel showed ONE campaign: the most live one in the workspace,
 * whatever identity it acted as. Production supports several campaigns
 * on one identity — two follow campaigns can be active at once, plus an
 * unfollow campaign — and the card implied the one it showed was the
 * only thing running. It now shows every active, rate-limited and
 * reauthorization-required campaign of BOTH kinds for the SELECTED
 * identity, each with its kind, and says that the identity's daily
 * ceiling is shared between them.
 *
 * DELIBERATELY CHEAP. Nothing here reads a queue. A campaign may hold
 * 100,000 members and this is a header panel: every number comes from
 * an exact `count(*) head` or from the day's run row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countMembersByStatus,
  getIdentityUsage,
  getRunForLocalDate,
  listCampaigns,
} from "@/repositories/bluesky-campaign-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { computeEffectiveQuota } from "./quota";
import {
  computeEffectiveUnfollowQuota,
  IDENTITY_DAILY_MUTATION_CEILING,
} from "@/core/bluesky-unfollow/quota";
import { localClockAt } from "./campaign-day";
import type { BlueskyCampaignStatus, BlueskyFollowCampaignRow } from "@/lib/supabase/types";

export interface CampaignSummary {
  id: string;
  kind: "follow" | "unfollow";
  name: string;
  status: BlueskyCampaignStatus;
  identityId: string;
  identityHandle: string | null;
  identityDisplayName: string | null;
  /** Members that have reached a terminal state. */
  completed: number;
  total: number;
  attemptedToday: number;
  succeededToday: number;
  failedToday: number;
  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  nextRunAt: string | null;
  dryRun: boolean;
  /** The campaign's own screen. */
  href: string;
}

export interface IdentityAutomationOverview {
  identityId: string;
  identityHandle: string | null;
  identityDisplayName: string | null;
  /** Live campaigns on this identity, most live first. */
  campaigns: CampaignSummary[];
  /** Today's spend against the shared ceiling, both kinds together. */
  followsToday: number;
  unfollowsToday: number;
  attemptsToday: number;
  ceiling: number;
  /** Live campaigns on OTHER identities in this workspace, for the hint. */
  otherIdentitiesLive: number;
}

/** Statuses that mean "doing something, or would be if unblocked". */
export const LIVE_STATUSES: readonly BlueskyCampaignStatus[] = [
  "active",
  "rate_limited",
  "reauthorization_required",
];

const LIVENESS: Record<string, number> = {
  active: 0,
  rate_limited: 1,
  reauthorization_required: 2,
};

async function summarise(
  c: BlueskyFollowCampaignRow,
  identity: { handle: string | null; displayName: string | null } | undefined,
  usage: { follows_created?: number; attempts_made?: number; unfollows_deleted?: number } | null,
  workspaceId: string,
  now: Date,
  db: SupabaseClient | undefined,
): Promise<CampaignSummary> {
  const clock = localClockAt(now, c.timezone);
  const [counts, today] = await Promise.all([
    countMembersByStatus({ workspaceId, campaignId: c.id, db }),
    getRunForLocalDate({ workspaceId, campaignId: c.id, localDate: clock.localDate, db }),
  ]);
  const followsToday = Number(usage?.follows_created ?? 0);
  const unfollowsToday = Number(usage?.unfollows_deleted ?? 0);
  const mutationsToday = Math.max(Number(usage?.attempts_made ?? 0), followsToday + unfollowsToday);

  const quota =
    c.kind === "unfollow"
      ? computeEffectiveUnfollowQuota({
          requested: c.requested_daily_quota,
          identityMutationsToday: mutationsToday,
          consecutiveFailures: today?.consecutive_failures ?? 0,
          maxConsecutiveFailures: c.max_consecutive_failures,
          resolvedToday: (today?.succeeded_count ?? 0) + (today?.failed_count ?? 0),
          succeededToday: today?.succeeded_count ?? 0,
          minSuccessRatePercent: c.min_success_rate_percent,
          rateLimitedUntil: c.rate_limited_until ? new Date(c.rate_limited_until) : null,
          remainingEligible: counts.remainingEligible,
          now,
        })
      : computeEffectiveQuota({
          requested: c.requested_daily_quota,
          identityFollowsToday: followsToday,
          consecutiveFailures: today?.consecutive_failures ?? 0,
          maxConsecutiveFailures: c.max_consecutive_failures,
          attemptedToday: (today?.succeeded_count ?? 0) + (today?.failed_count ?? 0),
          succeededToday: today?.succeeded_count ?? 0,
          minSuccessRatePercent: c.min_success_rate_percent,
          rateLimitedUntil: c.rate_limited_until ? new Date(c.rate_limited_until) : null,
          remainingEligible: counts.remainingEligible,
          now,
        });

  return {
    id: c.id,
    kind: c.kind === "unfollow" ? "unfollow" : "follow",
    name: c.name,
    status: c.status,
    identityId: c.operator_account_id,
    identityHandle: identity?.handle ?? null,
    identityDisplayName: identity?.displayName ?? null,
    completed: counts.total - counts.remainingEligible,
    total: counts.total,
    attemptedToday: today?.attempted_count ?? 0,
    succeededToday: today?.succeeded_count ?? 0,
    failedToday: today?.failed_count ?? 0,
    requestedDailyQuota: c.requested_daily_quota,
    effectiveDailyQuota: quota.effective,
    effectiveQuotaReason: quota.reason,
    nextRunAt: c.next_run_at,
    dryRun: c.dry_run,
    href:
      c.kind === "unfollow"
        ? `/relationships/unfollow/${c.id}`
        : `/relationships/campaigns?campaign=${encodeURIComponent(c.id)}`,
  };
}

/**
 * Every live campaign of both kinds on ONE identity, plus the
 * identity's spend against the shared ceiling. Null when the identity
 * has no live campaign — the CTA then leads to setup.
 *
 * When no identity is given, the identity with the most live campaigns
 * is used, so the panel never silently picks one campaign out of many.
 */
export async function loadIdentityAutomation(input: {
  workspaceId: string;
  operatorAccountId?: string | null;
  now?: Date;
  db?: SupabaseClient;
}): Promise<IdentityAutomationOverview | null> {
  const now = input.now ?? new Date();

  let campaigns: BlueskyFollowCampaignRow[];
  try {
    campaigns = await listCampaigns(input.workspaceId, 50, input.db);
  } catch {
    // The panel is an aside. A read failure here must not take down the
    // page an operator uses to work manually — the campaigns page
    // itself reports the failure properly.
    return null;
  }
  const live = campaigns.filter((c) => (LIVE_STATUSES as readonly string[]).includes(c.status));
  if (live.length === 0) return null;

  const byIdentity = new Map<string, BlueskyFollowCampaignRow[]>();
  for (const c of live) {
    byIdentity.set(c.operator_account_id, [...(byIdentity.get(c.operator_account_id) ?? []), c]);
  }
  let identityId = input.operatorAccountId ?? null;
  if (!identityId || !byIdentity.has(identityId)) {
    if (input.operatorAccountId) {
      // The selected identity has nothing live. Say so rather than
      // showing another identity's campaigns under its name.
      return {
        identityId: input.operatorAccountId,
        identityHandle: null,
        identityDisplayName: null,
        campaigns: [],
        followsToday: 0,
        unfollowsToday: 0,
        attemptsToday: 0,
        ceiling: IDENTITY_DAILY_MUTATION_CEILING,
        otherIdentitiesLive: byIdentity.size,
      };
    }
    identityId = [...byIdentity.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  }

  const accounts = await listAccountsByPlatform(input.workspaceId, "bluesky", input.db);
  const identity = accounts.find((a) => a.id === identityId);
  const usage = (await getIdentityUsage({
    workspaceId: input.workspaceId,
    operatorAccountId: identityId,
    usageDate: now.toISOString().slice(0, 10),
    db: input.db,
  })) as { follows_created?: number; attempts_made?: number; unfollows_deleted?: number } | null;

  const mine = (byIdentity.get(identityId) ?? []).sort(
    (a, b) => (LIVENESS[a.status] ?? 9) - (LIVENESS[b.status] ?? 9) || a.name.localeCompare(b.name),
  );
  const summaries: CampaignSummary[] = [];
  for (const c of mine) {
    summaries.push(await summarise(c, identity, usage, input.workspaceId, now, input.db));
  }
  const followsToday = Number(usage?.follows_created ?? 0);
  const unfollowsToday = Number(usage?.unfollows_deleted ?? 0);
  return {
    identityId,
    identityHandle: identity?.handle ?? null,
    identityDisplayName: identity?.displayName ?? null,
    campaigns: summaries,
    followsToday,
    unfollowsToday,
    attemptsToday: Math.max(Number(usage?.attempts_made ?? 0), followsToday + unfollowsToday),
    ceiling: IDENTITY_DAILY_MUTATION_CEILING,
    otherIdentitiesLive: byIdentity.size - 1,
  };
}

/**
 * @deprecated The one-campaign summary implied there was one campaign.
 * Kept for callers that only need "is anything live"; new code uses
 * `loadIdentityAutomation`.
 */
export async function loadCampaignSummary(input: {
  workspaceId: string;
  now?: Date;
  db?: SupabaseClient;
}): Promise<CampaignSummary | null> {
  const overview = await loadIdentityAutomation(input);
  return overview?.campaigns[0] ?? null;
}
