import type { PlatformId, WeeklyPlanItem } from "@/types";

const platformSuggested: Record<PlatformId, number> = {
  reddit: 2,
  x: 7,
  linkedin: 3,
};

const platformMax: Record<PlatformId, number> = {
  reddit: 4,
  x: 14,
  linkedin: 5,
};

export interface CadenceLoad {
  platform: PlatformId;
  count: number;
  suggested: number;
  max: number;
  utilization: number;
  isOver: boolean;
  isApproachingMax: boolean;
}

const activeStatuses = new Set([
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "published",
]);

export function platformLoad(
  items: Pick<WeeklyPlanItem, "platform" | "status">[],
): Record<PlatformId, CadenceLoad> {
  const platforms: PlatformId[] = ["reddit", "x", "linkedin"];
  const result = {} as Record<PlatformId, CadenceLoad>;
  for (const p of platforms) {
    const count = items.filter(
      (i) => i.platform === p && activeStatuses.has(i.status),
    ).length;
    const suggested = platformSuggested[p];
    const max = platformMax[p];
    result[p] = {
      platform: p,
      count,
      suggested,
      max,
      utilization: suggested === 0 ? 0 : count / suggested,
      isOver: count > suggested,
      isApproachingMax: count >= max - 1,
    };
  }
  return result;
}

export function accountWeeklyCount(
  accountId: string,
  items: Pick<WeeklyPlanItem, "accountId" | "status">[],
): number {
  return items.filter(
    (i) => i.accountId === accountId && activeStatuses.has(i.status),
  ).length;
}
