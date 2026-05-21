import type { PlatformId, WeeklyPlanItem } from "@/types";
import { dayOffsetFromIso, getPlatformWindow } from "./slots";
import { accountCooldownConflict, sameDayCount } from "./cooldown";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DistributionResult {
  proposedIso: string;
  movedFromIso: string | null;
  reason: string | null;
}

export interface DistributionContext {
  weekStartIso: string;
  others: WeeklyPlanItem[];
}

const platformPreferredDays: Record<PlatformId, number[]> = {
  reddit: [1, 2, 3, 4],
  x: [0, 1, 2, 3, 4, 5, 6],
  linkedin: [1, 2, 3],
};

const minutesByPlatformBaseline: Record<PlatformId, number[]> = {
  reddit: [10, 25, 40, 55],
  x: [5, 17, 33, 47],
  linkedin: [0, 15, 30, 45],
};

function pickMinute(platform: PlatformId, seed: number): number {
  const opts = minutesByPlatformBaseline[platform];
  return opts[seed % opts.length];
}

export function distributeItem(
  item: Pick<WeeklyPlanItem, "id" | "accountId" | "platform" | "scheduledFor" | "status">,
  ctx: DistributionContext,
): DistributionResult {
  const originalDay = dayOffsetFromIso(ctx.weekStartIso, item.scheduledFor);
  const others = ctx.others.filter((o) => o.id !== item.id);

  const tryDay = (day: number): string | null => {
    if (day < 0 || day > 6) return null;
    const window = getPlatformWindow(item.platform, ctx.weekStartIso, day);
    const sameDay = sameDayCount(item.accountId, isoAt(window.start), [
      ...others,
      { ...item, scheduledFor: isoAt(window.start) },
    ]);
    if (sameDay >= 1) return null;
    const minutes = pickMinute(item.platform, day + item.id.length);
    const candidate = window.start + minutes * 60_000;
    const cooldown = accountCooldownConflict(
      item.accountId,
      isoAt(candidate),
      others,
    );
    if (cooldown.conflict) return null;
    return isoAt(candidate);
  };

  const preferredDays = platformPreferredDays[item.platform];
  if (preferredDays.includes(originalDay)) {
    const same = tryDay(originalDay);
    if (same) {
      return { proposedIso: same, movedFromIso: null, reason: null };
    }
  }

  const candidates: number[] = [
    ...preferredDays,
    ...[0, 1, 2, 3, 4, 5, 6].filter((d) => !preferredDays.includes(d)),
  ];
  for (const day of candidates) {
    if (day === originalDay) continue;
    const placed = tryDay(day);
    if (placed) {
      return {
        proposedIso: placed,
        movedFromIso: item.scheduledFor,
        reason: buildMoveReason(item.platform, originalDay, day),
      };
    }
  }

  return {
    proposedIso: item.scheduledFor,
    movedFromIso: null,
    reason: "No safe slot available this week. Consider moving to the backlog.",
  };
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function buildMoveReason(platform: PlatformId, from: number, to: number): string {
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  if (platform === "reddit") {
    return `Reddit cadence needs spacing — recommended publishing window moved from ${days[from]} to ${days[to]}.`;
  }
  if (platform === "linkedin") {
    return `LinkedIn audience is most active mid-week — moved from ${days[from]} to ${days[to]}.`;
  }
  return `Account cooldown applied — moved from ${days[from]} to ${days[to]}.`;
}

export function redistributeAll(
  items: WeeklyPlanItem[],
  weekStartIso: string,
): { items: WeeklyPlanItem[]; moves: { id: string; from: string; to: string; reason: string }[] } {
  const sorted = [...items].sort(
    (a, b) =>
      promotionalWeight(a) - promotionalWeight(b) ||
      a.scheduledFor.localeCompare(b.scheduledFor),
  );

  const placed: WeeklyPlanItem[] = [];
  const moves: { id: string; from: string; to: string; reason: string }[] = [];

  for (const item of sorted) {
    const distribution = distributeItem(item, {
      weekStartIso,
      others: placed,
    });
    const next: WeeklyPlanItem = { ...item, scheduledFor: distribution.proposedIso };
    placed.push(next);
    if (distribution.movedFromIso && distribution.reason) {
      moves.push({
        id: item.id,
        from: distribution.movedFromIso,
        to: distribution.proposedIso,
        reason: distribution.reason,
      });
    }
  }

  return { items: placed, moves };
}

function promotionalWeight(item: WeeklyPlanItem): number {
  if (item.draft.trackingLinkId) return 2;
  if (item.draft.cta) return 1;
  return 0;
}

export const SCHEDULER_CONSTANTS = {
  DAY_MS,
  PROMOTIONAL_GAP_HOURS: 36,
};
