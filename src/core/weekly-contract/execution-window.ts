/**
 * Execution window evaluation.
 *
 * A contract may attach one or more (dayOfWeek, startTime, endTime)
 * windows. The runner asks: "is the candidate moment inside *any* of
 * those windows?" If yes, allowed. If no, soft_block with reason
 * `outside_execution_window`.
 *
 * Windows are wall-clock local-time tuples (e.g. Tue 09:00 – 17:00).
 * We do not store a timezone on the window itself — the workspace
 * timezone resolves the moment. The caller passes already-resolved
 * local components.
 */

import type { ExecutionWindowDef } from "./approval-contract-types";

export interface LocalMoment {
  /** 0 = Sunday … 6 = Saturday, matches JS Date.getDay(). */
  dayOfWeek: number;
  /** "HH:MM" 24h. */
  time: string;
}

export function isWithinAnyWindow(
  moment: LocalMoment,
  windows: ReadonlyArray<ExecutionWindowDef>,
): boolean {
  if (windows.length === 0) {
    // No windows declared = always-on. The contract envelope itself is
    // the gate, not the schedule.
    return true;
  }
  return windows.some((w) => isWithinWindow(moment, w));
}

export function isWithinWindow(
  moment: LocalMoment,
  window: ExecutionWindowDef,
): boolean {
  if (moment.dayOfWeek !== window.dayOfWeek) return false;
  return moment.time >= window.startTime && moment.time < window.endTime;
}

/**
 * Convert an absolute ISO timestamp into a LocalMoment in the given
 * IANA timezone. Falls back to the host timezone if `timezone` is null
 * or invalid; this is good enough for the boundary check, and the
 * authoritative timezone is later persisted on workspace_settings.
 */
export function toLocalMoment(
  iso: string,
  timezone: string | null,
): LocalMoment {
  const date = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (timezone) {
    try {
      opts.timeZone = timezone;
    } catch {
      // ignore, fall through to host tz
    }
  }
  const fmt = new Intl.DateTimeFormat("en-US", opts);
  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const normalizedHour = hour === "24" ? "00" : hour;
  return {
    dayOfWeek: weekdayToIndex(weekday),
    time: `${normalizedHour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
}

function weekdayToIndex(weekday: string): number {
  switch (weekday) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return 0;
  }
}

/**
 * Local-day key ("YYYY-MM-DD") for the same moment. Used by the cadence
 * snapshot accumulator.
 */
export function toLocalDayKey(
  iso: string,
  timezone: string | null,
): string {
  const date = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (timezone) {
    try {
      opts.timeZone = timezone;
    } catch {
      // ignore
    }
  }
  const fmt = new Intl.DateTimeFormat("en-CA", opts); // en-CA → YYYY-MM-DD
  return fmt.format(date);
}
