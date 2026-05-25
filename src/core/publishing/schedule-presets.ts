/**
 * Phase F2.8 — quick scheduling presets.
 *
 * Founder-friendly presets that resolve to a concrete future
 * timestamp in the caller's timezone. The list is intentionally
 * short — the brief calls for ~5 presets plus Custom.
 */

export type SchedulePresetId =
  | "today_evening"
  | "tomorrow_morning"
  | "tomorrow_afternoon"
  | "friday_morning"
  | "next_monday";

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  /** Short hint shown under the label, e.g. "Today, 6 pm". */
  hint: (now: Date) => string;
  /** Resolve the preset to a future Date (always in the future). */
  resolve: (now: Date) => Date;
}

function setLocalTime(d: Date, hour: number, minute = 0): Date {
  const out = new Date(d.getTime());
  out.setHours(hour, minute, 0, 0);
  return out;
}

function nextSpecificDay(now: Date, targetWeekday: number, hour: number): Date {
  // targetWeekday: 0=Sun ... 6=Sat
  const out = new Date(now.getTime());
  const day = out.getDay();
  let delta = (targetWeekday - day + 7) % 7;
  // If today is the target day AND the target hour has passed, jump
  // to next week.
  if (delta === 0) {
    const todayAtHour = setLocalTime(now, hour);
    if (todayAtHour.getTime() <= now.getTime()) delta = 7;
  }
  out.setDate(out.getDate() + delta);
  out.setHours(hour, 0, 0, 0);
  return out;
}

function tomorrowAt(now: Date, hour: number): Date {
  const out = new Date(now.getTime());
  out.setDate(out.getDate() + 1);
  out.setHours(hour, 0, 0, 0);
  return out;
}

function formatLocal(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "today_evening",
    label: "Today evening",
    hint: (now) => {
      const t = setLocalTime(now, 18);
      // If 6pm has passed, push to tomorrow evening instead.
      const resolved = t.getTime() <= now.getTime() ? tomorrowAt(now, 18) : t;
      return formatLocal(resolved);
    },
    resolve: (now) => {
      const t = setLocalTime(now, 18);
      return t.getTime() <= now.getTime() ? tomorrowAt(now, 18) : t;
    },
  },
  {
    id: "tomorrow_morning",
    label: "Tomorrow morning",
    hint: (now) => formatLocal(tomorrowAt(now, 9)),
    resolve: (now) => tomorrowAt(now, 9),
  },
  {
    id: "tomorrow_afternoon",
    label: "Tomorrow afternoon",
    hint: (now) => formatLocal(tomorrowAt(now, 14)),
    resolve: (now) => tomorrowAt(now, 14),
  },
  {
    id: "friday_morning",
    label: "Friday morning",
    hint: (now) => formatLocal(nextSpecificDay(now, 5, 9)),
    resolve: (now) => nextSpecificDay(now, 5, 9),
  },
  {
    id: "next_monday",
    label: "Next Monday",
    hint: (now) => formatLocal(nextSpecificDay(now, 1, 9)),
    resolve: (now) => nextSpecificDay(now, 1, 9),
  },
];

export function resolveSchedulePreset(
  id: SchedulePresetId,
  now = new Date(),
): Date {
  const preset = SCHEDULE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown schedule preset: ${id}`);
  return preset.resolve(now);
}

/**
 * Convert a Date to the value shape an `<input type="datetime-local">`
 * expects (local time, no tz suffix, minute precision).
 */
export function toDatetimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert an `<input type="datetime-local">` value (`YYYY-MM-DDTHH:MM`,
 * no timezone suffix) to an ISO-8601 UTC string, interpreting the
 * input in the *current* timezone of the caller.
 *
 * Why this exists: a bare `datetime-local` string has no tz suffix.
 * `new Date(localValue).toISOString()` parses it in the runtime's
 * local zone — which is the operator's browser on the client, but
 * UTC on Vercel. Round-tripping through a server action that runs
 * `new Date(localValue).toISOString()` therefore shifts the timestamp
 * by the operator's UTC offset each time the value lands back in the
 * input via `toDatetimeLocalString`. We do the conversion explicitly
 * client-side so the server only ever sees a fully-qualified ISO
 * string.
 *
 * Idempotent: if the caller passes a string that already contains a
 * timezone designator (`Z` or `±HH:MM`), it's returned as a normalized
 * ISO without a second TZ application.
 */
export function datetimeLocalToIso(localValue: string): string {
  const trimmed = localValue.trim();
  if (trimmed.length === 0) {
    throw new Error("datetimeLocalToIso: empty value");
  }
  // Already TZ-qualified — normalize via Date round-trip.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`datetimeLocalToIso: invalid value "${localValue}"`);
    }
    return d.toISOString();
  }
  // Bare datetime-local — `new Date` interprets in local zone, which
  // is the desired behavior client-side.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`datetimeLocalToIso: invalid value "${localValue}"`);
  }
  return d.toISOString();
}
