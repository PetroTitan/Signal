/**
 * Publishing cadence and inactivity (PURE).
 *
 * IMPORTANT CALIBRATION NOTE
 * --------------------------
 * The real evidence does NOT show over-posting, and this module must not
 * assume otherwise. Measured over Signal's actual publication history:
 *
 *   X        13 intervals, median 25.1h, min 4.0h, max 72.8h
 *   Bluesky  11 intervals, median 26.1h, min  5.7h, max 72.7h
 *
 * That is roughly one post per day per platform, which is unremarkable.
 * Only two same-day doubles occurred, each with a 4-6 hour gap. A cadence
 * model that flagged this would be inventing a problem, so the burst
 * threshold sits deliberately above it.
 *
 * The finding that IS in the data is the opposite one: a 63-day silence
 * between 13 June and 15 August. If reach declined over that period,
 * inactivity is a far more plausible driver than posting frequency — and
 * it is something Signal can measure and act on.
 *
 * Pure module — no I/O and no ambient clock; `nowIso` is always passed in
 * so every result is reproducible.
 */

import { median } from "./statistics";

export interface CadencePost {
  id: string;
  platform: string;
  /** ISO instant. */
  publishedAt: string;
}

/**
 * Posts inside this window count as one burst. Set at 6 hours / 3 posts:
 * strictly above the observed same-day doubles (2 posts, 4-6h apart), so
 * normal operation is never flagged.
 */
export const BURST_WINDOW_HOURS = 6;
export const BURST_MIN_POSTS = 3;

/** No publication for this long on a platform reads as a pause. */
export const INACTIVE_AFTER_DAYS = 14;

/** …and this long reads as a stopped campaign. */
export const DORMANT_AFTER_DAYS = 45;

/** Below this many posts, interval statistics are not reportable. */
export const MIN_POSTS_FOR_INTERVALS = 3;

export type CadenceState =
  | "active"
  | "paused"
  | "dormant"
  | "never_published"
  | "insufficient_data";

export interface Burst {
  startIso: string;
  endIso: string;
  posts: number;
  windowHours: number;
}

export interface CadenceSignal {
  platform: string;
  totalPosts: number;
  postsLast24h: number;
  postsLast7d: number;
  postsLast30d: number;
  firstPostIso: string | null;
  lastPostIso: string | null;
  daysSinceLastPost: number | null;
  /** Null below MIN_POSTS_FOR_INTERVALS — two posts is not a cadence. */
  medianIntervalHours: number | null;
  shortestIntervalHours: number | null;
  longestGapHours: number | null;
  bursts: Burst[];
  state: CadenceState;
  /** Operator-facing sentences. Never prescriptive about a "right" rate. */
  observations: string[];
}

export function analyzeCadence(
  posts: readonly CadencePost[],
  platform: string,
  nowIso: string,
): CadenceSignal {
  const now = Date.parse(nowIso);
  const ordered = posts
    .filter((p) => p.platform === platform && Number.isFinite(Date.parse(p.publishedAt)))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const base: CadenceSignal = {
    platform,
    totalPosts: ordered.length,
    postsLast24h: countSince(ordered, now, 24),
    postsLast7d: countSince(ordered, now, 24 * 7),
    postsLast30d: countSince(ordered, now, 24 * 30),
    firstPostIso: ordered[0]?.publishedAt ?? null,
    lastPostIso: ordered[ordered.length - 1]?.publishedAt ?? null,
    daysSinceLastPost: null,
    medianIntervalHours: null,
    shortestIntervalHours: null,
    longestGapHours: null,
    bursts: detectBursts(ordered),
    state: "never_published",
    observations: [],
  };

  if (ordered.length === 0) {
    base.observations.push(`No posts recorded on ${platform}.`);
    return base;
  }

  const lastMs = Date.parse(base.lastPostIso!);
  base.daysSinceLastPost = round1((now - lastMs) / 86_400_000);

  const intervals: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    intervals.push(
      (Date.parse(ordered[i].publishedAt) - Date.parse(ordered[i - 1].publishedAt)) /
        3_600_000,
    );
  }

  if (ordered.length >= MIN_POSTS_FOR_INTERVALS && intervals.length > 0) {
    const med = median(intervals);
    base.medianIntervalHours = med == null ? null : round1(med);
    base.shortestIntervalHours = round1(Math.min(...intervals));
    base.longestGapHours = round1(Math.max(...intervals));
  } else {
    base.observations.push(
      `${ordered.length} post${ordered.length === 1 ? "" : "s"} on ${platform} — too few to describe a posting rhythm.`,
    );
  }

  base.state = classifyState(base.daysSinceLastPost, ordered.length);
  base.observations.push(...describe(base, platform));
  return base;
}

function classifyState(
  daysSinceLastPost: number | null,
  totalPosts: number,
): CadenceState {
  if (totalPosts === 0) return "never_published";
  if (daysSinceLastPost == null) return "insufficient_data";
  if (daysSinceLastPost >= DORMANT_AFTER_DAYS) return "dormant";
  if (daysSinceLastPost >= INACTIVE_AFTER_DAYS) return "paused";
  return "active";
}

/**
 * Describe cadence WITHOUT prescribing a rate.
 *
 * Deliberately absent: any sentence of the form "you should post N times
 * per week". Signal has no evidence for an optimal frequency on these
 * accounts, and inventing one would be exactly the kind of confident
 * advice the data cannot support.
 */
function describe(signal: CadenceSignal, platform: string): string[] {
  const out: string[] = [];

  switch (signal.state) {
    case "dormant":
      out.push(
        `No ${platform} post for ${formatDays(signal.daysSinceLastPost!)}. ` +
          "A gap this long means recent performance reflects an inactive " +
          "account rather than how any particular post was received.",
      );
      break;
    case "paused":
      out.push(
        `No ${platform} post for ${formatDays(signal.daysSinceLastPost!)}.`,
      );
      break;
    case "active":
      out.push(
        `${signal.postsLast7d} ${platform} post${signal.postsLast7d === 1 ? "" : "s"} in the last 7 days` +
          (signal.postsLast24h > 0 ? `, ${signal.postsLast24h} in the last 24 hours.` : "."),
      );
      break;
    default:
      break;
  }

  if (signal.medianIntervalHours != null) {
    out.push(
      `Typical gap between ${platform} posts is ${formatHours(signal.medianIntervalHours)} ` +
        `(shortest ${formatHours(signal.shortestIntervalHours!)}, ` +
        `longest ${formatHours(signal.longestGapHours!)}).`,
    );
  }

  for (const burst of signal.bursts) {
    out.push(
      `${burst.posts} ${platform} posts within ${burst.windowHours} hours ` +
        `starting ${burst.startIso.slice(0, 16).replace("T", " ")} UTC.`,
    );
  }

  return out;
}

/**
 * Sliding window over the ordered series. Reports the maximal runs only,
 * so a 5-post cluster is one finding rather than three overlapping ones.
 */
export function detectBursts(ordered: readonly CadencePost[]): Burst[] {
  const bursts: Burst[] = [];
  const windowMs = BURST_WINDOW_HOURS * 3_600_000;
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (
      j + 1 < ordered.length &&
      Date.parse(ordered[j + 1].publishedAt) - Date.parse(ordered[i].publishedAt) <= windowMs
    ) {
      j += 1;
    }
    const count = j - i + 1;
    if (count >= BURST_MIN_POSTS) {
      bursts.push({
        startIso: ordered[i].publishedAt,
        endIso: ordered[j].publishedAt,
        posts: count,
        windowHours: BURST_WINDOW_HOURS,
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return bursts;
}

function countSince(
  ordered: readonly CadencePost[],
  nowMs: number,
  hours: number,
): number {
  const cutoff = nowMs - hours * 3_600_000;
  return ordered.filter((p) => Date.parse(p.publishedAt) >= cutoff).length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatHours(hours: number): string {
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function formatDays(days: number): string {
  if (days < 1) return "less than a day";
  const d = Math.round(days);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** Cadence across every platform present in the series. */
export function analyzeCadenceByPlatform(
  posts: readonly CadencePost[],
  nowIso: string,
): CadenceSignal[] {
  const platforms = Array.from(new Set(posts.map((p) => p.platform))).sort();
  return platforms.map((platform) => analyzeCadence(posts, platform, nowIso));
}
