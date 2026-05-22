import type { GrowthAccount, PlatformId, WeeklyPlanItem } from "@/types";
import { ACCOUNT_HEALTH_POLICY } from "./account-health-policy";

const platformCooldownHours: Record<PlatformId, number> = {
  reddit: 36,
  x: 6,
  linkedin: 24,
};

export interface CadenceRecommendation {
  delayHours: number;
  reason: string;
}

export function recommendCadenceDelay(
  account: GrowthAccount,
  items: Pick<WeeklyPlanItem, "accountId" | "scheduledFor" | "platform" | "status">[],
  candidateIso: string,
): CadenceRecommendation | null {
  const candidate = new Date(candidateIso).getTime();
  const same = items.filter(
    (i) =>
      i.accountId === account.id &&
      i.status !== "backlog" &&
      i.status !== "rejected" &&
      i.status !== "skipped" &&
      i.scheduledFor !== candidateIso,
  );
  if (same.length === 0) return null;

  const minCooldownMs = platformCooldownHours[account.platform] * 60 * 60 * 1000;
  let nearest = Infinity;
  for (const item of same) {
    const diff = Math.abs(new Date(item.scheduledFor).getTime() - candidate);
    if (diff < nearest) nearest = diff;
  }
  if (nearest >= minCooldownMs) return null;

  const need = Math.ceil((minCooldownMs - nearest) / (60 * 60 * 1000));
  return {
    delayHours: need,
    reason: `Account cooldown shortfall: needs ${platformCooldownHours[account.platform]}h between posts.`,
  };
}

export interface AccountCalmScore {
  score: number;
  level: "calm" | "active" | "high_velocity";
  reasons: string[];
}

export function calculateAccountCalmScore(
  account: GrowthAccount,
  items: Pick<WeeklyPlanItem, "accountId" | "status" | "draft">[],
): AccountCalmScore {
  const accountItems = items.filter(
    (i) =>
      i.accountId === account.id &&
      i.status !== "rejected" &&
      i.status !== "backlog" &&
      i.status !== "skipped",
  );
  const promotional = accountItems.filter(
    (i) => i.draft.trackingLinkId !== null || (i.draft.cta?.length ?? 0) > 0,
  ).length;
  const promoRatio = accountItems.length === 0 ? 0 : promotional / accountItems.length;
  const reasons: string[] = [];
  let score = 80;

  if (accountItems.length > ACCOUNT_HEALTH_POLICY.highVelocityThreshold) {
    score -= 25;
    reasons.push("Account is publishing above the recommended weekly cap.");
  }
  if (promoRatio > ACCOUNT_HEALTH_POLICY.maxDirectLinkRatio) {
    score -= 20;
    reasons.push(
      `Promotional share is ${Math.round(promoRatio * 100)}% — over the safe ratio.`,
    );
  }
  if (account.status === "warming" && promotional > 0) {
    score -= 25;
    reasons.push("Account is still warming and already has promotional items.");
  }
  score = Math.max(0, Math.min(100, score));

  const level: AccountCalmScore["level"] =
    score >= 70
      ? "calm"
      : score >= 45
        ? "active"
        : "high_velocity";

  return { score, level, reasons };
}
