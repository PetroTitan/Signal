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
