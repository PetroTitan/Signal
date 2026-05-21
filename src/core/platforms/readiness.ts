import type {
  GrowthAccount,
  PlatformId,
  PlatformReadinessSnapshot,
} from "@/types";
import { ELIGIBLE_FOR_PLANNING } from "@/types";
import { computeReadiness } from "../onboarding/readiness";

const setupStatuses = new Set([
  "planned",
  "setup_needed",
  "awaiting_manual_creation",
]);

export function calculatePlatformReadiness(
  platform: PlatformId,
  accounts: GrowthAccount[],
): PlatformReadinessSnapshot {
  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const accountsTotal = platformAccounts.length;
  const accountsEligible = platformAccounts.filter((a) =>
    ELIGIBLE_FOR_PLANNING.includes(a.status),
  ).length;
  const accountsInSetup = platformAccounts.filter((a) =>
    setupStatuses.has(a.status),
  ).length;

  const averageAccountReadiness =
    accountsTotal === 0
      ? 0
      : Math.round(
          platformAccounts.reduce((sum, a) => sum + computeReadiness(a), 0) /
            accountsTotal,
        );

  const eligibleWeight = accountsTotal === 0 ? 0 : accountsEligible / accountsTotal;
  const overallScore = Math.round(
    averageAccountReadiness * 0.6 + eligibleWeight * 100 * 0.4,
  );

  let status: PlatformReadinessSnapshot["status"] = "in_setup";
  if (accountsTotal === 0) {
    status = "blocked";
  } else if (accountsEligible >= 1 && overallScore >= 60) {
    status = "ready";
  }

  return {
    platform,
    accountsTotal,
    accountsEligible,
    accountsInSetup,
    averageAccountReadiness,
    overallScore,
    status,
  };
}
