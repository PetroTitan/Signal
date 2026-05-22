import type { GrowthAccount, PlatformId, WeeklyPlanItem } from "@/types";
import { ACCOUNT_HEALTH_POLICY } from "./account-health-policy";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SilenceRecommendation {
  recommend: boolean;
  reason: string;
}

export function shouldRecommendSilence(
  account: GrowthAccount,
  items: Pick<WeeklyPlanItem, "accountId" | "platform" | "scheduledFor" | "status">[],
  candidateIso: string,
): SilenceRecommendation {
  const sameAccountThisWeek = items.filter(
    (i) =>
      i.accountId === account.id &&
      i.status !== "backlog" &&
      i.status !== "rejected" &&
      i.status !== "skipped",
  );

  if (
    sameAccountThisWeek.length >= ACCOUNT_HEALTH_POLICY.highVelocityThreshold
  ) {
    return {
      recommend: true,
      reason:
        "Account is already at the weekly cap. Quiet days protect long-term presence.",
    };
  }

  const candidateDay = new Date(candidateIso).toISOString().slice(0, 10);
  const sameDay = sameAccountThisWeek.filter(
    (i) => new Date(i.scheduledFor).toISOString().slice(0, 10) === candidateDay,
  );
  if (sameDay.length >= 1) {
    return {
      recommend: true,
      reason: "Another item is already scheduled on this account today.",
    };
  }

  return { recommend: false, reason: "Silence not required for this slot." };
}

export function countQuietDays(
  items: Pick<WeeklyPlanItem, "platform" | "scheduledFor" | "status">[],
  platform: PlatformId,
  weekStartIso: string,
): number {
  const platformItems = items.filter(
    (i) =>
      i.platform === platform &&
      i.status !== "backlog" &&
      i.status !== "rejected" &&
      i.status !== "skipped",
  );
  const days = new Set<string>();
  for (const i of platformItems) {
    days.add(new Date(i.scheduledFor).toISOString().slice(0, 10));
  }
  const week = new Date(weekStartIso).getTime();
  const allDays = new Set<string>();
  for (let d = 0; d < 7; d++) {
    allDays.add(new Date(week + d * DAY_MS).toISOString().slice(0, 10));
  }
  let quiet = 0;
  for (const day of allDays) if (!days.has(day)) quiet++;
  return quiet;
}
