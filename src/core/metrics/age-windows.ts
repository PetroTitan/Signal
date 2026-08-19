/**
 * Post-age normalization (PURE).
 *
 * Cumulative engagement counts are meaningless across posts of different
 * ages. A 45-minute-old post and a 4-day-old post have had wildly
 * different exposure, so comparing their like counts measures elapsed
 * time, not performance. Every comparison in this milestone is therefore
 * age-bucketed, and a comparison that cannot be bucketed does not happen.
 *
 * The windows are fixed rather than derived so that a bucket means the
 * same thing forever: a "24h" reading is always a reading taken when the
 * post was between 12 and 48 hours old, regardless of when the sweep
 * happened to run.
 *
 * Pure module — no I/O, no clock (every function takes its instants).
 */

import type { MetricAgeWindow } from "@/lib/supabase/types";

export type AgeWindow = MetricAgeWindow;

/** Comparison windows, youngest first. `older` is the catch-all tail. */
export const AGE_WINDOWS: AgeWindow[] = ["1h", "6h", "24h", "72h", "7d", "older"];

/** Nominal age each window represents, in hours. */
export const WINDOW_TARGET_HOURS: Record<Exclude<AgeWindow, "older">, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "72h": 72,
  "7d": 168,
};

/**
 * Bucket boundaries. Each window claims readings from its lower bound up
 * to (not including) the next — chosen so the geometric midpoint between
 * targets is the split, which keeps a reading in the window it is
 * closest to rather than the one it happens to exceed.
 *
 *   1h     [0, 3)
 *   6h     [3, 12)
 *   24h    [12, 48)
 *   72h    [48, 120)
 *   7d     [120, 336)
 *   older  [336, ∞)
 */
const WINDOW_BOUNDS: Array<{ window: AgeWindow; minHours: number; maxHours: number }> = [
  { window: "1h", minHours: 0, maxHours: 3 },
  { window: "6h", minHours: 3, maxHours: 12 },
  { window: "24h", minHours: 12, maxHours: 48 },
  { window: "72h", minHours: 48, maxHours: 120 },
  { window: "7d", minHours: 120, maxHours: 336 },
  { window: "older", minHours: 336, maxHours: Number.POSITIVE_INFINITY },
];

export function windowBounds(window: AgeWindow): { minHours: number; maxHours: number } {
  const found = WINDOW_BOUNDS.find((b) => b.window === window);
  return found ?? { minHours: 0, maxHours: Number.POSITIVE_INFINITY };
}

/**
 * Hours between publication and the reading. Returns null when either
 * instant is unusable, or when the reading predates publication — a
 * negative age means the timestamps disagree, and guessing which one is
 * right would corrupt every downstream comparison.
 */
export function ageHours(
  publishedAtIso: string | null | undefined,
  fetchedAtIso: string | null | undefined,
): number | null {
  if (!publishedAtIso || !fetchedAtIso) return null;
  const published = Date.parse(publishedAtIso);
  const fetched = Date.parse(fetchedAtIso);
  if (!Number.isFinite(published) || !Number.isFinite(fetched)) return null;
  const hours = (fetched - published) / 3_600_000;
  if (hours < 0) return null;
  return Math.round(hours * 100) / 100;
}

/** Which window a reading of this age falls in. Null age → null window. */
export function classifyAgeWindow(hours: number | null | undefined): AgeWindow | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  for (const bound of WINDOW_BOUNDS) {
    if (hours >= bound.minHours && hours < bound.maxHours) return bound.window;
  }
  return "older";
}

/** Convenience: age + window from two instants. */
export function resolveAge(
  publishedAtIso: string | null | undefined,
  fetchedAtIso: string | null | undefined,
): { ageHours: number | null; ageWindow: AgeWindow | null } {
  const hours = ageHours(publishedAtIso, fetchedAtIso);
  return { ageHours: hours, ageWindow: classifyAgeWindow(hours) };
}

export function windowLabel(window: AgeWindow): string {
  switch (window) {
    case "1h":
      return "1 hour after posting";
    case "6h":
      return "6 hours after posting";
    case "24h":
      return "24 hours after posting";
    case "72h":
      return "3 days after posting";
    case "7d":
      return "7 days after posting";
    default:
      return "more than 14 days after posting";
  }
}

export interface WindowedReading<T> {
  ageWindow: AgeWindow | null;
  value: T;
}

/**
 * Pick the reading for a requested window. Returns null when no reading
 * exists in that bucket — the caller must render "not measured at this
 * age", NEVER interpolate between neighbouring windows. An interpolated
 * point is a fabricated provider value, which is the one thing this
 * subsystem must not produce.
 */
export function readingForWindow<T>(
  readings: ReadonlyArray<WindowedReading<T>>,
  window: AgeWindow,
): T | null {
  const match = readings.find((r) => r.ageWindow === window);
  return match ? match.value : null;
}

/**
 * Whether two posts can be compared at all.
 *
 * Both must have a reading in the SAME window. This is the gate that
 * stops "this post did better than that one" being a statement about
 * elapsed time.
 */
export function comparableInWindow(
  a: { ageWindow: AgeWindow | null },
  b: { ageWindow: AgeWindow | null },
): boolean {
  return a.ageWindow != null && a.ageWindow === b.ageWindow;
}

/**
 * The refresh instants that would land a post in each window, given when
 * it was published. Used to schedule snapshots so the buckets actually
 * get filled instead of being populated by whenever the cron woke up.
 */
export function snapshotSchedule(publishedAtIso: string): Array<{
  window: Exclude<AgeWindow, "older">;
  atIso: string;
}> {
  const published = Date.parse(publishedAtIso);
  if (!Number.isFinite(published)) return [];
  return (Object.keys(WINDOW_TARGET_HOURS) as Array<Exclude<AgeWindow, "older">>)
    .map((window) => ({
      window,
      atIso: new Date(published + WINDOW_TARGET_HOURS[window] * 3_600_000).toISOString(),
    }))
    .sort((a, b) => a.atIso.localeCompare(b.atIso));
}
