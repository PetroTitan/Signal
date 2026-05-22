import type { GrowthAccount, PlatformId, WeeklyPlanItem } from "@/types";
import { ACCOUNT_HEALTH_POLICY } from "./account-health-policy";

const platformLinkTolerance: Record<PlatformId, number> = {
  reddit: 0.1,
  x: 0.3,
  linkedin: 0.5,
};

export interface LinkSuppressionVerdict {
  suppress: boolean;
  reason: string;
}

export function shouldSuppressLink(
  account: GrowthAccount,
  candidate: Pick<WeeklyPlanItem, "draft" | "platform">,
  items: Pick<WeeklyPlanItem, "accountId" | "platform" | "draft" | "status">[],
): LinkSuppressionVerdict {
  if (account.status === "warming") {
    return {
      suppress: true,
      reason: "Account is warming. Hold outbound links until warm-up completes.",
    };
  }
  const sameAccount = items.filter(
    (i) =>
      i.accountId === account.id &&
      i.status !== "backlog" &&
      i.status !== "rejected" &&
      i.status !== "skipped",
  );
  const promotional = sameAccount.filter(
    (i) => i.draft.trackingLinkId !== null || (i.draft.cta?.length ?? 0) > 0,
  );
  const ratio =
    sameAccount.length === 0 ? 0 : promotional.length / sameAccount.length;
  if (ratio >= platformLinkTolerance[candidate.platform]) {
    return {
      suppress: true,
      reason: `Promotional ratio (${Math.round(ratio * 100)}%) is at or above the platform's tolerance.`,
    };
  }
  if (ratio >= ACCOUNT_HEALTH_POLICY.maxDirectLinkRatio) {
    return {
      suppress: true,
      reason: "Workspace policy: keep the promotional share under one-third.",
    };
  }
  return { suppress: false, reason: "Link OK to keep." };
}
