/**
 * What "a day" means for a campaign, and when it may run.
 *
 * Pure, client-safe. No `Date.now()` is read implicitly — every entry
 * point takes the instant, so behaviour at a DST boundary is testable
 * rather than dependent on when the suite happens to run.
 *
 * WHY THIS IS NOT TRIVIAL
 * -----------------------
 * A daily quota has to mean "per local calendar day in the operator's
 * timezone", or an operator in Auckland gets their quota reset in the
 * middle of their afternoon. That makes DST a correctness problem, not
 * a cosmetic one:
 *
 *   - On a spring-forward day the local clock skips an hour. A window
 *     of 02:00–03:00 in America/New_York does not EXIST on 2026-03-08.
 *     Reconstructing "today at 02:00 local" as a timestamp produces a
 *     nonexistent instant, and a campaign configured that way would
 *     never run.
 *   - On a fall-back day 01:00–02:00 local happens TWICE. A window
 *     inside it is entered twice, which must not create two daily runs.
 *
 * Both are avoided the same way: we never build a local timestamp and
 * compare instants. We take the instant we already have, ask
 * `Intl.DateTimeFormat` what the local wall-clock date and time are at
 * that instant, and compare minutes-from-midnight. A skipped hour
 * simply never matches; a repeated hour matches twice on the same local
 * DATE, and the unique index on (campaign, local_date) collapses that
 * to one run.
 *
 * Node ships the full IANA database (418 zones, verified), so no
 * timezone table is bundled.
 */

/** A campaign's local wall-clock position at some instant. */
export interface LocalClock {
  /** YYYY-MM-DD in the campaign's timezone. The daily-run key. */
  localDate: string;
  /** Minutes since local midnight, 0..1439. */
  minutesOfDay: number;
  /** For display and diagnostics, e.g. "EDT". */
  timeZoneName: string;
}

export class InvalidTimezoneError extends Error {
  constructor(timezone: string) {
    super(`"${timezone}" is not a timezone this runtime recognises.`);
    this.name = "InvalidTimezoneError";
  }
}

/** Whether the runtime accepts this IANA zone. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The local date and time-of-day at `instant`, in `timezone`.
 *
 * `en-CA` is chosen for the date because it formats as YYYY-MM-DD,
 * which is both the Postgres DATE literal format and lexicographically
 * sortable — so no parsing or reassembly is needed.
 */
export function localClockAt(instant: Date, timezone: string): LocalClock {
  if (!isValidTimezone(timezone)) throw new InvalidTimezoneError(timezone);

  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // `hour12: false` yields 24 for midnight in some ICU versions; 24:00
  // is midnight of the same local date, i.e. minute 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));

  return {
    localDate,
    minutesOfDay: hour * 60 + minute,
    timeZoneName: get("timeZoneName"),
  };
}

export interface ExecutionWindow {
  /** Minutes from local midnight, inclusive. */
  startMinute: number;
  /** Minutes from local midnight, exclusive. */
  endMinute: number;
}

/**
 * Is `instant` inside the campaign's daily window?
 *
 * Half-open [start, end): a window ending at 20:00 does not include
 * 20:00, so a window of 09:00–20:00 and one of 20:00–23:00 do not
 * overlap at their shared edge.
 */
export function isWithinWindow(
  instant: Date,
  timezone: string,
  window: ExecutionWindow,
): boolean {
  const clock = localClockAt(instant, timezone);
  return (
    clock.minutesOfDay >= window.startMinute &&
    clock.minutesOfDay < window.endMinute
  );
}

/**
 * The next instant at which the campaign should be looked at again.
 *
 * Deliberately approximate and always in the FUTURE. It is a hint for
 * the dispatcher's index, not a promise: the cron fires every few
 * minutes regardless, and the window check on the instant is what
 * actually decides. Getting this slightly wrong costs a skipped tick,
 * never a missed day.
 *
 * It is computed by probing forward in fixed steps rather than by
 * constructing a local timestamp, for the reason in the module note: a
 * local time on a spring-forward day may not exist.
 */
export function computeNextRunAt(input: {
  from: Date;
  timezone: string;
  window: ExecutionWindow;
  /** Don't schedule before this local date (campaign start). */
  notBeforeLocalDate?: string | null;
}): Date {
  const { from, timezone, window } = input;
  const STEP_MS = 5 * 60_000;
  const HORIZON_STEPS = (48 * 60) / 5; // two days of 5-minute steps

  for (let i = 1; i <= HORIZON_STEPS; i += 1) {
    const probe = new Date(from.getTime() + i * STEP_MS);
    const clock = localClockAt(probe, timezone);
    if (
      input.notBeforeLocalDate &&
      clock.localDate < input.notBeforeLocalDate
    ) {
      continue;
    }
    if (
      clock.minutesOfDay >= window.startMinute &&
      clock.minutesOfDay < window.endMinute
    ) {
      return probe;
    }
  }
  // No window found in 48 hours. Shouldn't happen for a valid window,
  // but returning a far-future instant is safer than returning the past
  // (which would make the dispatcher spin on this campaign).
  return new Date(from.getTime() + 24 * 60 * 60_000);
}

/** Minutes-from-midnight → "HH:MM", for display and form values. */
export function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.trunc(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" → minutes from midnight, or null when unparseable. */
export function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  const total = h * 60 + m;
  return total > 1440 ? null : total;
}

/**
 * A small set of zones offered in the UI picker.
 *
 * The runtime accepts all 418, and the form accepts any valid one — this
 * is only what is listed by default so an operator is not scrolling a
 * 418-item select on a phone.
 */
export const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Prague",
  "Europe/Kyiv",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;
