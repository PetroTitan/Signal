import type {
  BacklogItem,
  GrowthAccount,
  PlatformActionRecommendation,
  PlatformId,
  RiskEvent,
  WeeklyPlanItem,
} from "@/types";
import { calculatePlatformCadenceLoad } from "./load";
import { calculatePlatformReadiness } from "./readiness";

interface RecInput {
  platform: PlatformId;
  accounts: GrowthAccount[];
  items: WeeklyPlanItem[];
  riskEvents?: RiskEvent[];
  backlog?: BacklogItem[];
}

export function getPlatformRecommendations({
  platform,
  accounts,
  items,
  riskEvents = [],
  backlog = [],
}: RecInput): PlatformActionRecommendation[] {
  const out: PlatformActionRecommendation[] = [];
  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const platformItems = items.filter((i) => i.platform === platform);
  const readiness = calculatePlatformReadiness(platform, accounts);
  const load = calculatePlatformCadenceLoad(platform, items);

  if (platformAccounts.length === 0) {
    out.push({
      id: `${platform}_no_accounts`,
      platform,
      level: "block",
      text: "No accounts configured for this platform. Add one via the account setup assistant.",
    });
    return out;
  }

  if (readiness.accountsEligible === 0) {
    out.push({
      id: `${platform}_no_eligible`,
      platform,
      level: "block",
      text: "No accounts are eligible for weekly planning yet. Finish setup and warm-up on at least one account.",
    });
  }

  const blockedItems = platformItems.filter(
    (i) => i.risk.level === "blocked",
  ).length;
  if (blockedItems > 0) {
    out.push({
      id: `${platform}_blocked_items`,
      platform,
      level: "warn",
      text: `${blockedItems} item${blockedItems === 1 ? "" : "s"} on this platform are blocked by the risk engine. Move them to the backlog or fix the underlying account.`,
    });
  }

  if (load.isOver) {
    out.push({
      id: `${platform}_overload`,
      platform,
      level: "warn",
      text: `Over suggested ${load.suggested}/week cadence. ${load.count} items scheduled — consider redistributing or moving extras to the backlog.`,
    });
  } else if (load.isApproachingMax) {
    out.push({
      id: `${platform}_approaching_max`,
      platform,
      level: "info",
      text: `Approaching the weekly cap (${load.count}/${load.max}). New items will likely be deferred.`,
    });
  }

  // Platform-specific recommendations
  if (platform === "reddit") {
    const promoItems = platformItems.filter(
      (i) => i.draft.trackingLinkId || i.draft.cta,
    );
    if (promoItems.length > 1) {
      out.push({
        id: "reddit_promo_load",
        platform,
        level: "warn",
        text: `${promoItems.length} promotional items planned for Reddit this week. Reddit cadence tolerates one at most — backlog the rest.`,
      });
    }
    const warmingAccounts = platformAccounts.filter(
      (a) => a.status === "warming",
    );
    if (warmingAccounts.length > 0) {
      out.push({
        id: "reddit_warm_focus",
        platform,
        level: "info",
        text: `${warmingAccounts.length} Reddit account${warmingAccounts.length === 1 ? "" : "s"} still warming. Lead with comments this week, not posts.`,
      });
    }
  }

  if (platform === "x") {
    const replyCount = platformItems.filter(
      (i) => i.contentType === "comment_reply",
    ).length;
    const postCount = platformItems.length - replyCount;
    if (postCount > 0 && replyCount === 0) {
      out.push({
        id: "x_no_replies",
        platform,
        level: "warn",
        text: "No replies scheduled this week. On X, replies are first-class presence — plan at least one reply per active account.",
      });
    }
    const threadCount = platformItems.filter(
      (i) => i.contentType === "thread",
    ).length;
    if (threadCount > 2) {
      out.push({
        id: "x_thread_density",
        platform,
        level: "warn",
        text: `${threadCount} threads scheduled — threads are deliberate. Two per week is usually enough.`,
      });
    }
  }

  if (platform === "linkedin") {
    const longForm = platformItems.filter(
      (i) =>
        i.contentType === "long_form_article" ||
        i.contentType === "case_study",
    );
    if (longForm.length === 0 && platformItems.length > 0) {
      out.push({
        id: "linkedin_no_longform",
        platform,
        level: "info",
        text: "No long-form essay or case study planned this week. LinkedIn rewards depth — consider adding one.",
      });
    }
    const promo = platformItems.filter((i) => i.draft.trackingLinkId).length;
    if (promo > 1) {
      out.push({
        id: "linkedin_promo_too_high",
        platform,
        level: "warn",
        text: `${promo} promotional posts scheduled on LinkedIn. Keep promotional rhythm under one per account per week.`,
      });
    }
  }

  const platformRisks = riskEvents.filter((r) => r.platform === platform);
  if (platformRisks.some((r) => r.level === "high")) {
    out.push({
      id: `${platform}_high_risk_event`,
      platform,
      level: "warn",
      text: "Open high-risk signals on this platform in the risk center. Review before publishing.",
    });
  }

  const platformBacklog = backlog.filter((b) => b.platform === platform);
  if (platformBacklog.length > 0) {
    out.push({
      id: `${platform}_backlog_available`,
      platform,
      level: "info",
      text: `${platformBacklog.length} held item${platformBacklog.length === 1 ? "" : "s"} in the backlog for this platform. Restore one only when cadence has room.`,
    });
  }

  if (out.length === 0) {
    out.push({
      id: `${platform}_all_clear`,
      platform,
      level: "info",
      text: "All clear. Cadence, risk, and account readiness look healthy this week.",
    });
  }

  return out;
}
