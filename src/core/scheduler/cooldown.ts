import type { PlatformId, WeeklyPlanItem } from "@/types";

const HOUR_MS = 60 * 60 * 1000;

const platformMinHours: Record<PlatformId, number> = {
  reddit: 36,
  x: 6,
  linkedin: 24,
};

export function minCooldownHours(platform: PlatformId): number {
  return platformMinHours[platform];
}

export function accountCooldownConflict(
  accountId: string,
  candidateIso: string,
  others: Pick<WeeklyPlanItem, "accountId" | "scheduledFor" | "platform" | "status">[],
): { conflict: boolean; hoursFromNearest: number; minRequired: number } {
  const candidate = new Date(candidateIso).getTime();
  const accountItems = others.filter(
    (o) =>
      o.accountId === accountId &&
      o.scheduledFor !== candidateIso &&
      o.status !== "rejected" &&
      o.status !== "skipped" &&
      o.status !== "backlog",
  );
  if (accountItems.length === 0) {
    return { conflict: false, hoursFromNearest: Infinity, minRequired: 0 };
  }
  let nearestHours = Infinity;
  let minRequired = 0;
  for (const it of accountItems) {
    const diff = Math.abs(candidate - new Date(it.scheduledFor).getTime()) / HOUR_MS;
    const required = platformMinHours[it.platform];
    if (diff < nearestHours) nearestHours = diff;
    if (required > minRequired) minRequired = required;
  }
  return {
    conflict: nearestHours < minRequired,
    hoursFromNearest: nearestHours,
    minRequired,
  };
}

export function sameDayCount(
  accountId: string,
  candidateIso: string,
  others: Pick<WeeklyPlanItem, "accountId" | "scheduledFor" | "status">[],
): number {
  const candidateDay = new Date(candidateIso).toISOString().slice(0, 10);
  return others.filter(
    (o) =>
      o.accountId === accountId &&
      o.status !== "rejected" &&
      o.status !== "skipped" &&
      o.status !== "backlog" &&
      o.scheduledFor !== candidateIso &&
      new Date(o.scheduledFor).toISOString().slice(0, 10) === candidateDay,
  ).length;
}
