import type {
  PublishingWindow,
  SupportedRegion,
} from "@/types/geo";
import { REGION_METADATA } from "./region-policy";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];

export interface DefaultPublishingWindows {
  region: SupportedRegion;
  windows: PublishingWindow[];
}

export const DEFAULT_PUBLISHING_WINDOWS: Record<
  SupportedRegion,
  PublishingWindow[]
> = {
  us_east: [
    { label: "Morning business hours", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Lunch window", startHourLocal: 12, endHourLocal: 13, daysOfWeek: WEEKDAYS },
    { label: "Evening operator hours", startHourLocal: 17, endHourLocal: 20, daysOfWeek: WEEKDAYS },
  ],
  us_central: [
    { label: "Morning business hours", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Evening operator hours", startHourLocal: 17, endHourLocal: 20, daysOfWeek: WEEKDAYS },
  ],
  us_west: [
    { label: "Morning business hours", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Evening operator hours", startHourLocal: 17, endHourLocal: 20, daysOfWeek: WEEKDAYS },
  ],
  eu_west: [
    { label: "Morning workday", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Afternoon workday", startHourLocal: 14, endHourLocal: 18, daysOfWeek: WEEKDAYS },
  ],
  eu_central: [
    { label: "Morning workday", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Afternoon workday", startHourLocal: 14, endHourLocal: 18, daysOfWeek: WEEKDAYS },
  ],
  uk: [
    { label: "Morning workday", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Afternoon workday", startHourLocal: 14, endHourLocal: 18, daysOfWeek: WEEKDAYS },
  ],
  jp: [
    { label: "JST morning", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "JST afternoon", startHourLocal: 13, endHourLocal: 18, daysOfWeek: WEEKDAYS },
  ],
  apac: [
    { label: "Local morning", startHourLocal: 9, endHourLocal: 12, daysOfWeek: WEEKDAYS },
    { label: "Local afternoon", startHourLocal: 14, endHourLocal: 18, daysOfWeek: WEEKDAYS },
  ],
  global: [
    { label: "UTC working hours", startHourLocal: 8, endHourLocal: 20, daysOfWeek: ALL_DAYS },
  ],
};

export function defaultTimezoneForRegion(region: SupportedRegion): string {
  return REGION_METADATA[region].defaultTimezone;
}

export function defaultLanguageForRegion(region: SupportedRegion): string {
  return REGION_METADATA[region].defaultLanguage;
}

export function defaultWindowsForRegion(
  region: SupportedRegion,
): PublishingWindow[] {
  return DEFAULT_PUBLISHING_WINDOWS[region];
}

export function inWindow(
  window: PublishingWindow,
  localDayOfWeek: number,
  localHour: number,
): boolean {
  if (!window.daysOfWeek.includes(localDayOfWeek)) return false;
  return localHour >= window.startHourLocal && localHour < window.endHourLocal;
}

/**
 * Returns the first window that contains the given local clock value, or null.
 * Deterministic. Does not call any platform API and does not schedule.
 */
export function activeWindow(
  windows: PublishingWindow[],
  localDayOfWeek: number,
  localHour: number,
): PublishingWindow | null {
  for (const w of windows) {
    if (inWindow(w, localDayOfWeek, localHour)) return w;
  }
  return null;
}
