/**
 * Phase B1 — pure calendar-grid builder for the scheduling view.
 *
 * Turns a flat list of scheduled events (each carrying an ISO publish
 * time) into a month or week grid bucketed by WORKSPACE-LOCAL day, so
 * the calendar matches the same wall clock the rest of the operator UI
 * uses. Source of truth is the caller's `scheduledAt` (from
 * execution_items / plan items) — this module never reads a clock for
 * the events themselves; it only places them.
 *
 * Pure module — no I/O, no React. The page passes already-loaded,
 * already-filtered events (only items that are genuinely scheduled —
 * published / failed items must be excluded by the caller, per the B1
 * tests).
 */

export type CalendarMode = "month" | "week";

export interface CalendarEvent {
  id: string;
  /** ISO publish time (UTC). */
  scheduledAt: string;
  title: string | null;
  platform: string | null;
  /** Operator-facing status label/token for coloring. */
  status: string;
  /** Deep link to the item detail. */
  href: string;
}

export interface CalendarDay {
  /** YYYY-MM-DD in the workspace zone. */
  dateKey: string;
  /** Day-of-month number. */
  day: number;
  /** True when this cell belongs to the focused month (month view). */
  inFocusMonth: boolean;
  /** True when this cell is the workspace-local "today". */
  isToday: boolean;
  events: CalendarEvent[];
}

export interface CalendarGrid {
  mode: CalendarMode;
  /** First day rendered (workspace-local YYYY-MM-DD). */
  rangeStartKey: string;
  /** Last day rendered. */
  rangeEndKey: string;
  /** Human label, e.g. "June 2026" or "Jun 8 – Jun 14, 2026". */
  label: string;
  /** Weeks, each a row of 7 days (Mon–Sun). */
  weeks: CalendarDay[][];
  /** ISO anchor for prev/next navigation (start of the range, UTC noon). */
  prevAnchorIso: string;
  nextAnchorIso: string;
  todayAnchorIso: string;
}

// --- workspace-zone date math (mirrors weekly-plan/page bucketing) ---

/** YYYY-MM-DD for an instant in the given IANA zone. */
function zonedDateKey(instant: Date, timezone: string): string {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** {year,month(1-12),day} for an instant in the given zone. */
function zonedParts(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * A representative UTC instant for "the day that is `dayOffset` days
 * from the zoned day of `anchor`". We anchor at 12:00 UTC to stay far
 * from DST transition windows; the calendar only needs day resolution.
 */
function dayKeyFromOffset(
  anchorZonedYmd: { year: number; month: number; day: number },
  dayOffset: number,
  timezone: string,
): { key: string; day: number; year: number; month: number } {
  // Build a UTC noon for the anchor's zoned Y/M/D, then add offset days.
  const base = Date.UTC(
    anchorZonedYmd.year,
    anchorZonedYmd.month - 1,
    anchorZonedYmd.day,
    12,
    0,
    0,
  );
  const instant = new Date(base + dayOffset * 24 * 60 * 60 * 1000);
  const p = zonedParts(instant, timezone);
  return { key: zonedDateKey(instant, timezone), day: p.day, year: p.year, month: p.month };
}

/** Mon=0 … Sun=6 for a zoned day. */
function isoWeekdayIndex(
  ymd: { year: number; month: number; day: number },
): number {
  const dow = new Date(
    Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12, 0, 0),
  ).getUTCDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7; // 0=Mon..6=Sun
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function noonUtcIso(ymd: { year: number; month: number; day: number }): string {
  return new Date(
    Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12, 0, 0),
  ).toISOString();
}

export interface BuildCalendarInput {
  events: CalendarEvent[];
  /** IANA timezone (pass "UTC" when none configured). */
  timezone: string;
  /** The instant the view is centered on (defaults to now). */
  anchor: Date;
  mode: CalendarMode;
  /** "now" for the today highlight (defaults to anchor). */
  now?: Date;
}

/**
 * Build a month (6 weeks, Mon-aligned) or week (1 row) grid and drop
 * each event into its workspace-local day cell.
 */
export function buildCalendarGrid(input: BuildCalendarInput): CalendarGrid {
  const { events, timezone, anchor, mode } = input;
  const now = input.now ?? anchor;
  const todayKey = zonedDateKey(now, timezone);
  const anchorYmd = zonedParts(anchor, timezone);

  // Bucket events by zoned day key once.
  const byKey = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const d = new Date(e.scheduledAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = zonedDateKey(d, timezone);
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }
  // Sort each day's events by time.
  for (const list of byKey.values()) {
    list.sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
    );
  }

  let startOffsetFromAnchor: number;
  let totalDays: number;
  let label: string;

  if (mode === "week") {
    // Start of the anchor's Mon-aligned week.
    startOffsetFromAnchor = -isoWeekdayIndex(anchorYmd);
    totalDays = 7;
    const startCell = dayKeyFromOffset(anchorYmd, startOffsetFromAnchor, timezone);
    const endCell = dayKeyFromOffset(anchorYmd, startOffsetFromAnchor + 6, timezone);
    label = `${MONTH_NAMES[startCell.month - 1].slice(0, 3)} ${startCell.day} – ${MONTH_NAMES[endCell.month - 1].slice(0, 3)} ${endCell.day}, ${endCell.year}`;
  } else {
    // Month view: walk to the 1st of the anchor month, then back to the
    // Monday on/just before it; render 6 full weeks (42 cells).
    const firstOfMonth = { year: anchorYmd.year, month: anchorYmd.month, day: 1 };
    const offsetToFirst = 1 - anchorYmd.day; // days from anchor to the 1st
    const firstWeekday = isoWeekdayIndex(firstOfMonth);
    startOffsetFromAnchor = offsetToFirst - firstWeekday;
    totalDays = 42;
    label = `${MONTH_NAMES[anchorYmd.month - 1]} ${anchorYmd.year}`;
  }

  const focusMonth = mode === "month" ? anchorYmd.month : null;
  const weeks: CalendarDay[][] = [];
  let current: CalendarDay[] = [];
  for (let i = 0; i < totalDays; i++) {
    const cell = dayKeyFromOffset(anchorYmd, startOffsetFromAnchor + i, timezone);
    current.push({
      dateKey: cell.key,
      day: cell.day,
      inFocusMonth: focusMonth === null ? true : cell.month === focusMonth,
      isToday: cell.key === todayKey,
      events: byKey.get(cell.key) ?? [],
    });
    if (current.length === 7) {
      weeks.push(current);
      current = [];
    }
  }
  if (current.length > 0) weeks.push(current);

  const rangeStart = dayKeyFromOffset(anchorYmd, startOffsetFromAnchor, timezone);
  const rangeEnd = dayKeyFromOffset(
    anchorYmd,
    startOffsetFromAnchor + totalDays - 1,
    timezone,
  );

  // Prev/next anchors. Week: ±7 days from the anchor's zoned day.
  // Month: the 15th of the adjacent month (15th avoids month-length
  // edge cases and lands squarely inside the target month).
  const prevAnchor =
    mode === "week"
      ? dayKeyFromOffset(anchorYmd, -7, timezone)
      : {
          year: anchorYmd.month === 1 ? anchorYmd.year - 1 : anchorYmd.year,
          month: anchorYmd.month === 1 ? 12 : anchorYmd.month - 1,
          day: 15,
        };
  const nextAnchor =
    mode === "week"
      ? dayKeyFromOffset(anchorYmd, 7, timezone)
      : {
          year: anchorYmd.month === 12 ? anchorYmd.year + 1 : anchorYmd.year,
          month: anchorYmd.month === 12 ? 1 : anchorYmd.month + 1,
          day: 15,
        };

  return {
    mode,
    rangeStartKey: rangeStart.key,
    rangeEndKey: rangeEnd.key,
    label,
    weeks,
    prevAnchorIso: noonUtcIso(prevAnchor),
    nextAnchorIso: noonUtcIso(nextAnchor),
    todayAnchorIso: noonUtcIso(zonedParts(now, timezone)),
  };
}

/** Parse a `?anchor=` ISO param into a Date, defaulting to now. */
export function parseCalendarAnchor(
  raw: string | string[] | undefined,
  now: Date,
): Date {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return now;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? now : d;
}

export function parseCalendarMode(
  raw: string | string[] | undefined,
): CalendarMode {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "week" ? "week" : "month";
}
