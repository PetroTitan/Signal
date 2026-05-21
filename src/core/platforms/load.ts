import type {
  PlatformCadenceLoadSummary,
  PlatformId,
  WeeklyPlanItem,
} from "@/types";
import { platformLoad } from "../scheduler/cadence";
import { getPlatformCadencePolicy } from "./strategy";

export function calculatePlatformCadenceLoad(
  platform: PlatformId,
  items: WeeklyPlanItem[],
): PlatformCadenceLoadSummary {
  const load = platformLoad(items)[platform];
  const policy = getPlatformCadencePolicy(platform);
  return {
    platform,
    count: load.count,
    suggested: load.suggested,
    max: load.max,
    utilization: load.utilization,
    isOver: load.isOver,
    isApproachingMax: load.isApproachingMax,
    mode: policy.cadenceMode,
  };
}

export function groupWeeklyItemsByPlatform<T extends { platform: PlatformId }>(
  items: T[],
  platform: PlatformId,
): T[] {
  return items.filter((i) => i.platform === platform);
}
