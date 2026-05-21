import type { PlatformId } from "@/types";

export interface SlotWindow {
  start: number;
  end: number;
  dayOffset: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const platformWindows: Record<PlatformId, { startHourUtc: number; endHourUtc: number }> = {
  reddit: { startHourUtc: 14, endHourUtc: 22 },
  x: { startHourUtc: 13, endHourUtc: 21 },
  linkedin: { startHourUtc: 8, endHourUtc: 16 },
};

export function getPlatformWindow(platform: PlatformId, weekStartIso: string, dayOffset: number): SlotWindow {
  const week = new Date(weekStartIso);
  const day = new Date(week.getTime() + dayOffset * DAY_MS);
  const window = platformWindows[platform];
  const start = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    window.startHourUtc,
  );
  const end = start + (window.endHourUtc - window.startHourUtc) * HOUR_MS;
  return { start, end, dayOffset };
}

export function weekDayOffsets(): number[] {
  return [0, 1, 2, 3, 4, 5, 6];
}

export function clampToWeek(weekStartIso: string, target: number): number {
  const start = new Date(weekStartIso).getTime();
  const end = start + 7 * DAY_MS - 1;
  if (target < start) return start;
  if (target > end) return end;
  return target;
}

export function dayOffsetFromIso(weekStartIso: string, iso: string): number {
  const start = new Date(weekStartIso).getTime();
  const t = new Date(iso).getTime();
  return Math.floor((t - start) / DAY_MS);
}
