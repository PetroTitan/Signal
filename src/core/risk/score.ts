import type {
  GrowthAccount,
  PlatformId,
  ProductProfile,
  RiskLevel,
  RiskScore,
  WeeklyPlanItem,
} from "@/types";
import { accountWeeklyCount, platformLoad } from "../scheduler/cadence";
import { accountCooldownConflict, sameDayCount } from "../scheduler/cooldown";
import {
  COMPARATIVE_PHRASES,
  PROMOTIONAL_PHRASES,
  RISK_THRESHOLDS,
} from "./policies";

const HOUR_MS = 60 * 60 * 1000;

interface ScoreContext {
  item: WeeklyPlanItem;
  account: GrowthAccount;
  product: ProductProfile;
  others: WeeklyPlanItem[];
}

export function scoreItem(ctx: ScoreContext): RiskScore {
  const { item, account, product, others } = ctx;
  const reasons: string[] = [];
  let score = 0;

  const text = `${item.draft.hook} ${item.draft.body} ${item.draft.cta ?? ""}`.toLowerCase();

  const promotionalPhraseCount = PROMOTIONAL_PHRASES.filter((p) =>
    text.includes(p),
  ).length;
  const comparativePhraseCount = COMPARATIVE_PHRASES.filter((p) =>
    text.includes(p),
  ).length;
  if (promotionalPhraseCount > 0) {
    score += 10 * promotionalPhraseCount;
    reasons.push(
      `Promotional phrasing detected (${promotionalPhraseCount} phrase${promotionalPhraseCount === 1 ? "" : "s"}).`,
    );
  }
  if (comparativePhraseCount > 0) {
    score += 12 * comparativePhraseCount;
    reasons.push(
      "Comparative claim against another product detected — consider rewriting softer.",
    );
  }

  const hasOutboundLink = item.draft.trackingLinkId !== null;
  const ctaPresent = item.draft.cta !== null && item.draft.cta.length > 0;
  if (hasOutboundLink) {
    score += 12;
    reasons.push("Outbound product link present.");
  }
  if (ctaPresent && product.ctaStyle === "no_cta") {
    score += 30;
    reasons.push(`${product.name} CTA policy is 'no_cta' — remove CTA.`);
  }

  const sameAccountOthers = others.filter((o) => o.id !== item.id);
  const promoOnSameAccount = sameAccountOthers.filter(
    (o) =>
      o.accountId === item.accountId &&
      (o.draft.trackingLinkId !== null || (o.draft.cta?.length ?? 0) > 0),
  ).length;
  if (hasOutboundLink && promoOnSameAccount >= 1) {
    score += 18;
    reasons.push(
      "Direct-link saturation risk on this account this week.",
    );
  }

  const dupHooks = sameAccountOthers.filter(
    (o) =>
      o.draft.hook.trim().toLowerCase() === item.draft.hook.trim().toLowerCase(),
  ).length;
  if (dupHooks > 0) {
    score += 25;
    reasons.push("Duplicate hook found in another scheduled item.");
  }

  const sameDomainCount = sameAccountOthers.filter(
    (o) => o.productId === item.productId && o.draft.trackingLinkId !== null,
  ).length;
  if (hasOutboundLink && sameDomainCount > 0) {
    score += 8 * sameDomainCount;
    reasons.push("Repeated outbound domain from this workspace this week.");
  }

  const cad = platformLoad(others);
  const platformInfo = cad[item.platform as PlatformId];
  if (platformInfo.isOver) {
    score += 14;
    reasons.push(
      `${prettyPlatform(item.platform)} is over its suggested weekly cadence.`,
    );
  } else if (platformInfo.isApproachingMax) {
    score += 8;
    reasons.push(
      `${prettyPlatform(item.platform)} is approaching its weekly cap.`,
    );
  }

  const accountThisWeek = accountWeeklyCount(item.accountId, others);
  if (accountThisWeek >= 3) {
    score += 8 + (accountThisWeek - 3) * 4;
    reasons.push(
      `${account.displayName} already has ${accountThisWeek} items this week.`,
    );
  }

  const sameDay = sameDayCount(
    item.accountId,
    item.scheduledFor,
    sameAccountOthers,
  );
  if (sameDay >= 1) {
    score += 22;
    reasons.push("Same-day repetition for this account.");
  }

  const cooldown = accountCooldownConflict(
    item.accountId,
    item.scheduledFor,
    sameAccountOthers,
  );
  if (cooldown.conflict) {
    score += 18;
    reasons.push(
      `Cooldown shortfall: ${cooldown.hoursFromNearest.toFixed(0)}h between posts, ${cooldown.minRequired}h required.`,
    );
  }

  const sync = synchronizedWithinMinutes(item, sameAccountOthers, 15);
  if (sync !== null) {
    score += 10;
    reasons.push(
      `Synchronized posting risk — another item within ${sync} minutes.`,
    );
  }

  if (
    account.status === "planned" ||
    account.status === "setup_needed" ||
    account.status === "awaiting_manual_creation"
  ) {
    score += 60;
    reasons.push(`Account is in '${account.status.replace(/_/g, " ")}' status — not ready to publish.`);
  } else if (account.status === "warming") {
    score += 12;
    reasons.push("Account still warming. Keep tone observational, link-free if possible.");
  }

  if (product.riskTolerance === "conservative") {
    score = Math.round(score * 1.15);
  } else if (product.riskTolerance === "assertive") {
    score = Math.round(score * 0.9);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const level = toLevel(score, account.status);
  const recommendation = buildRecommendation(level, reasons);

  return { score, level, reasons, recommendation };
}

function toLevel(score: number, accountStatus: GrowthAccount["status"]): RiskLevel {
  if (
    accountStatus === "planned" ||
    accountStatus === "setup_needed" ||
    accountStatus === "awaiting_manual_creation"
  ) {
    return "blocked";
  }
  if (score >= RISK_THRESHOLDS.high) return "blocked";
  if (score >= RISK_THRESHOLDS.medium) return "high";
  if (score >= RISK_THRESHOLDS.low) return "medium";
  return "low";
}

function buildRecommendation(level: RiskLevel, reasons: string[]): string {
  switch (level) {
    case "blocked":
      return "Hold publishing. Move to the backlog or re-plan for next week.";
    case "high":
      return reasons[0]
        ? `Recommended cooldown: 3 days. ${reasons[0]}`
        : "Recommended cooldown: 3 days.";
    case "medium":
      return reasons[0]
        ? `Soften tone or delay 24h. ${reasons[0]}`
        : "Soften tone or delay 24h.";
    case "low":
    default:
      return "Safe to publish on schedule.";
  }
}

function synchronizedWithinMinutes(
  item: Pick<WeeklyPlanItem, "scheduledFor" | "accountId">,
  others: Pick<WeeklyPlanItem, "scheduledFor" | "accountId" | "status">[],
  minutes: number,
): number | null {
  const t = new Date(item.scheduledFor).getTime();
  for (const o of others) {
    if (
      o.status === "rejected" ||
      o.status === "skipped" ||
      o.status === "backlog"
    )
      continue;
    const diff = Math.abs(t - new Date(o.scheduledFor).getTime());
    if (diff <= minutes * 60_000 && o.accountId !== item.accountId) {
      return Math.round(diff / 60_000);
    }
  }
  return null;
}

function prettyPlatform(p: PlatformId): string {
  return p === "x" ? "X" : p === "reddit" ? "Reddit" : "LinkedIn";
}

export function scoreAllItems(
  items: WeeklyPlanItem[],
  accountsById: Record<string, GrowthAccount>,
  productsById: Record<string, ProductProfile>,
): WeeklyPlanItem[] {
  return items.map((item) => {
    const account = accountsById[item.accountId];
    const product = productsById[item.productId];
    if (!account || !product) return item;
    return {
      ...item,
      risk: scoreItem({ item, account, product, others: items }),
    };
  });
}

export const RISK_HOUR_MS = HOUR_MS;
