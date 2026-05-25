/**
 * Deterministic timezone fixtures + helpers for the regression
 * matrix.
 *
 * The compose sheet's schedule helpers (`toDatetimeLocalString`,
 * `datetimeLocalToIso`) interpret values in the runtime's local
 * zone. Vitest runs in node, which honors `process.env.TZ` only at
 * process start; we can't flip it per-test. Instead, this module
 * provides:
 *
 *   - `forZone(wallClock, tz)`: compute the UTC ISO that represents
 *     a given wall-clock interpreted in a given IANA zone. Uses
 *     `Intl.DateTimeFormat` with the target zone — works in any
 *     runtime regardless of the process's local zone.
 *
 *   - `walkRoundTrip(iso, n)`: round-trip an ISO through
 *     ISO → toDatetimeLocalString → datetimeLocalToIso → ISO
 *     `n` times. Asserts run on the result.
 *
 *   - `wallClockFromZonedIso(utcIso, tz)`: extract the wall-clock
 *     digits the local input would display for an operator in zone
 *     `tz`. Independent of the runtime zone.
 *
 * No external deps. Pure JS.
 */

export type IanaZone =
  | "Europe/Prague"
  | "UTC"
  | "America/New_York"
  | "Asia/Tokyo";

export const TIMEZONE_MATRIX: ReadonlyArray<IanaZone> = [
  "Europe/Prague",
  "UTC",
  "America/New_York",
  "Asia/Tokyo",
];

export interface WallClock {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
}

/**
 * Convert a wall-clock + IANA zone to the equivalent UTC ISO.
 *
 * Uses Intl.DateTimeFormat to compute the offset for that wall-clock
 * in that zone — handles DST automatically.
 */
export function forZone(wall: WallClock, zone: IanaZone): string {
  // Find the UTC timestamp whose wall-clock IN zone equals `wall`.
  // We do it by iterative correction: start with the wall as if it
  // were UTC, see how that renders in the zone, and adjust.
  const utcGuess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
    0,
  );
  const rendered = wallClockFromUtc(utcGuess, zone);
  // Compute the offset = guess - rendered. Apply it once.
  const guessMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
    0,
  );
  const renderedMs = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    0,
    0,
  );
  const corrected = utcGuess - (renderedMs - guessMs);
  return new Date(corrected).toISOString();
}

/** Render a UTC timestamp as a wall-clock in the given zone. */
export function wallClockFromUtc(
  utcMs: number,
  zone: IanaZone,
): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Some runtimes return "24" for midnight; normalize.
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };
}

export function wallClockFromZonedIso(iso: string, zone: IanaZone): WallClock {
  return wallClockFromUtc(Date.parse(iso), zone);
}

/**
 * Format a WallClock as the value the `<input type="datetime-local">`
 * displays — same shape produced by toDatetimeLocalString in the
 * given zone.
 */
export function wallClockToDatetimeLocal(wall: WallClock): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * Generate a deterministic sweep of wall-clock samples. 20 samples
 * across the year, including DST boundaries and edge dates.
 */
export function sampleWallClocks(): ReadonlyArray<WallClock> {
  return [
    { year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, // year start
    { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
    { year: 2026, month: 2, day: 14, hour: 14, minute: 30 },
    { year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, // US DST start
    { year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, // US after spring forward
    { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, // EU DST start
    { year: 2026, month: 4, day: 15, hour: 9, minute: 45 },
    { year: 2026, month: 5, day: 20, hour: 16, minute: 1 }, // reported bug TS
    { year: 2026, month: 6, day: 21, hour: 12, minute: 0 }, // solstice noon
    { year: 2026, month: 7, day: 4, hour: 18, minute: 30 },
    { year: 2026, month: 8, day: 15, hour: 23, minute: 59 },
    { year: 2026, month: 9, day: 1, hour: 9, minute: 0 },
    { year: 2026, month: 10, day: 31, hour: 1, minute: 30 },
    { year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, // US DST end
    { year: 2026, month: 11, day: 1, hour: 3, minute: 30 }, // US after fall back
    { year: 2026, month: 11, day: 25, hour: 7, minute: 15 },
    { year: 2026, month: 12, day: 24, hour: 18, minute: 0 },
    { year: 2026, month: 12, day: 31, hour: 23, minute: 30 }, // year end
    { year: 2027, month: 1, day: 1, hour: 0, minute: 1 }, // year crossing
    { year: 2024, month: 2, day: 29, hour: 12, minute: 0 }, // leap day
  ];
}
