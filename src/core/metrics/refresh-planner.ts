/**
 * Age-window refresh planner (PURE).
 *
 * The previous milestone defined the comparison windows. Nothing then
 * targeted them: the sweep re-read every connected post on a flat
 * 6-hour cooldown, forever. That has two failures at once — it never
 * fills the 1h window (the cron runs daily), and it keeps paying to
 * re-read year-old posts whose counters stopped moving months ago.
 *
 * This planner decides, per post, WHEN the next read should happen and
 * WHETHER one is worth doing at all. It is a pure function of the post's
 * age and which windows it already has, so it is testable without a
 * database, a clock or a provider.
 *
 * PROVIDER CONSTRAINTS ARE PART OF THE PLAN
 *   - Bluesky has no impressions and never will, so nothing here ever
 *     schedules a read hoping to collect one.
 *   - X's 30-day expiry applies to `non_public_metrics` and
 *     `organic_metrics`. Signal deliberately does not request either —
 *     it reads `public_metrics`, which carries impressions and has no
 *     documented age limit. So that cliff does NOT gate what Signal
 *     collects, and pretending it does would be theatre.
 *
 * THE EXPIRY THAT IS REAL
 * -----------------------
 * A comparison window closes permanently. A 1h reading cannot be taken
 * for a post that is now six hours old, at any price, from any provider.
 * That is what urgency here means: an unmeasured post whose current
 * window is about to close, where waiting one more sweep loses the
 * reading for good.
 */

import {
  AGE_WINDOWS,
  WINDOW_TARGET_HOURS,
  ageHours,
  classifyAgeWindow,
  type AgeWindow,
} from "./age-windows";

/** Windows a post is actively refreshed through. `older` is terminal. */
export const PLANNED_WINDOWS: Array<Exclude<AgeWindow, "older">> = [
  "1h",
  "6h",
  "24h",
  "72h",
  "7d",
];

/**
 * After the 7d window a post is complete: counters have essentially
 * stopped moving and every further read costs money on X for a number
 * that will not change. Complete is a terminal state, not a pause.
 */
export const ARCHIVE_AFTER_WINDOW: AgeWindow = "7d";

/**
 * Documented for reference: X's private-metric expiry. NOT used for
 * scheduling, because Signal reads only `public_metrics`, which this
 * limit does not apply to. Kept so a future contributor who adds
 * non-public metrics finds the constraint already written down.
 */
export const X_PRIVATE_METRIC_WINDOW_DAYS = 30;

/**
 * A window is "closing" when this share of it remains. An unmeasured post
 * inside that tail is urgent: one more sweep and the reading is lost.
 */
export const WINDOW_CLOSING_FRACTION = 0.25;

export type PlanAction =
  | "read_now"
  | "wait"
  | "complete"
  | "unmeasurable"
  | "backfill_only";

export type PlanPriority = "urgent" | "normal" | "low";

export interface PlannerPost {
  publishHistoryId: string;
  platform: string;
  publishedAt: string;
  hasProviderId: boolean;
  /** Windows this post already has a reading for. */
  coveredWindows: readonly AgeWindow[];
  /** When the canonical row was last read, if ever. */
  lastReadAt: string | null;
}

export interface PlanEntry {
  publishHistoryId: string;
  platform: string;
  action: PlanAction;
  priority: PlanPriority;
  /** The window this read is aiming to fill. */
  targetWindow: AgeWindow | null;
  /** When the next read should happen. Null for terminal states. */
  nextReadAt: string | null;
  ageHours: number | null;
  reason: string;
}

export interface PlannerOptions {
  nowIso: string;
  /** Publications older than this can only be reached by the backfill. */
  seedWindowDays: number;
}

export function planRefresh(
  post: PlannerPost,
  options: PlannerOptions,
): PlanEntry {
  const base = { publishHistoryId: post.publishHistoryId, platform: post.platform };
  const age = ageHours(post.publishedAt, options.nowIso);

  if (!post.hasProviderId) {
    return {
      ...base,
      action: "unmeasurable",
      priority: "low",
      targetWindow: null,
      nextReadAt: null,
      ageHours: age,
      reason: "No provider post id, so this publication can never be read.",
    };
  }

  if (age == null) {
    return {
      ...base,
      action: "unmeasurable",
      priority: "low",
      targetWindow: null,
      nextReadAt: null,
      ageHours: null,
      reason: "Publication time is unusable, so no window can be computed.",
    };
  }

  const covered = new Set(post.coveredWindows);

  // Terminal: everything through the last planned window is recorded.
  if (PLANNED_WINDOWS.every((w) => covered.has(w))) {
    return {
      ...base,
      action: "complete",
      priority: "low",
      targetWindow: null,
      nextReadAt: null,
      ageHours: age,
      reason: `All ${PLANNED_WINDOWS.length} comparison windows are recorded. Counters have stopped moving; further reads would cost without adding information.`,
    };
  }

  // Terminal: past the last window with gaps that can no longer be filled.
  // A 1h reading cannot be taken for a month-old post at any price.
  const currentWindow = classifyAgeWindow(age);
  if (currentWindow === "older") {
    const missed = PLANNED_WINDOWS.filter((w) => !covered.has(w));
    return {
      ...base,
      action: "complete",
      priority: "low",
      targetWindow: null,
      nextReadAt: null,
      ageHours: age,
      reason:
        `Past every comparison window with ${missed.length} never recorded ` +
        `(${missed.join(", ")}). Those readings are unobtainable now — a 1h ` +
        "measurement cannot be taken retrospectively.",
    };
  }

  // The next window this post has NOT got and has already reached.
  const dueWindow = PLANNED_WINDOWS.find(
    (w) => !covered.has(w) && age >= windowOpensAt(w),
  );

  if (dueWindow) {
    // Beyond the sweep's enrolment reach: real work, wrong mechanism.
    const withinSweepReach = age <= options.seedWindowDays * 24;
    if (!withinSweepReach) {
      return {
        ...base,
        action: "backfill_only",
        priority: "normal",
        targetWindow: dueWindow,
        nextReadAt: null,
        ageHours: age,
        reason: `Due a ${dueWindow} reading but older than the ${options.seedWindowDays}-day enrolment window. Only the bounded backfill can reach it.`,
      };
    }

    return {
      ...base,
      action: "read_now",
      priority: prioritise(post, age, covered, dueWindow),
      targetWindow: dueWindow,
      nextReadAt: options.nowIso,
      ageHours: age,
      reason: describeDue(post, dueWindow, age),
    };
  }

  // Nothing due yet — wait for the next window to open.
  const nextWindow = PLANNED_WINDOWS.find((w) => !covered.has(w));
  if (!nextWindow) {
    return {
      ...base,
      action: "complete",
      priority: "low",
      targetWindow: null,
      nextReadAt: null,
      ageHours: age,
      reason: "Every window is recorded.",
    };
  }

  const publishedMs = Date.parse(post.publishedAt);
  const nextReadAt = new Date(
    publishedMs + WINDOW_TARGET_HOURS[nextWindow] * 3_600_000,
  ).toISOString();

  return {
    ...base,
    action: "wait",
    priority: "low",
    targetWindow: nextWindow,
    nextReadAt,
    ageHours: age,
    reason: `${formatHours(age)} old; the ${nextWindow} window opens at ${WINDOW_TARGET_HOURS[nextWindow]}h.`,
  };
}

/**
 * Urgent = this reading is about to become unobtainable.
 *
 * Not a provider-billing concern and not a guess about tiers: a window
 * literally closes. Once a post leaves the bucket, the reading for that
 * window can never be taken.
 */
export function isWindowClosing(
  window: Exclude<AgeWindow, "older">,
  age: number,
): boolean {
  const bounds = windowBoundsFor(window);
  if (!Number.isFinite(bounds.closesAt)) return false;
  const span = bounds.closesAt - bounds.opensAt;
  if (span <= 0) return false;
  return age >= bounds.closesAt - span * WINDOW_CLOSING_FRACTION;
}

function prioritise(
  post: PlannerPost,
  age: number,
  covered: ReadonlySet<AgeWindow>,
  dueWindow: Exclude<AgeWindow, "older">,
): PlanPriority {
  if (isWindowClosing(dueWindow, age)) return "urgent";
  return covered.size === 0 ? "normal" : "low";
}

function describeDue(
  post: PlannerPost,
  window: Exclude<AgeWindow, "older">,
  age: number,
): string {
  if (isWindowClosing(window, age)) {
    const closesAt = windowBoundsFor(window).closesAt;
    return `Due a ${window} reading and the window closes at ${formatHours(closesAt)}; the post is already ${formatHours(age)} old. Miss it and this reading can never be taken.`;
  }
  return `Due a ${window} reading (${formatHours(age)} old, none recorded for that window).`;
}

/**
 * When a window opens and closes, in hours since publication.
 *
 * It OPENS at its nominal target — a reading taken ten minutes after
 * publication is not a "1h" measurement — and CLOSES where the next
 * bucket begins, after which the post has moved on.
 */
export function windowBoundsFor(window: Exclude<AgeWindow, "older">): {
  opensAt: number;
  closesAt: number;
} {
  const index = AGE_WINDOWS.indexOf(window);
  const next = AGE_WINDOWS[index + 1];
  const closesAt =
    next && next !== "older"
      ? WINDOW_TARGET_HOURS[next as Exclude<AgeWindow, "older">]
      : 336; // the "older" boundary
  return { opensAt: WINDOW_TARGET_HOURS[window], closesAt };
}

/** When a window opens, i.e. its nominal target age. */
export function windowOpensAt(window: Exclude<AgeWindow, "older">): number {
  return WINDOW_TARGET_HOURS[window];
}

export interface RefreshPlan {
  entries: PlanEntry[];
  readNow: PlanEntry[];
  urgent: PlanEntry[];
  backfillOnly: PlanEntry[];
  complete: number;
  waiting: number;
  unmeasurable: number;
  summary: string;
}

/**
 * Plan a whole batch. Read-now entries come back sorted urgent-first, so
 * a capped run spends its budget on the readings that expire soonest.
 */
export function planRefreshBatch(
  posts: readonly PlannerPost[],
  options: PlannerOptions,
): RefreshPlan {
  const entries = posts
    .map((p) => planRefresh(p, options))
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.publishHistoryId.localeCompare(b.publishHistoryId),
    );

  const readNow = entries.filter((e) => e.action === "read_now");
  const urgent = readNow.filter((e) => e.priority === "urgent");
  const backfillOnly = entries.filter((e) => e.action === "backfill_only");

  return {
    entries,
    readNow,
    urgent,
    backfillOnly,
    complete: entries.filter((e) => e.action === "complete").length,
    waiting: entries.filter((e) => e.action === "wait").length,
    unmeasurable: entries.filter((e) => e.action === "unmeasurable").length,
    summary:
      `${readNow.length} post(s) due a read now` +
      (urgent.length > 0 ? `, ${urgent.length} urgent` : "") +
      `; ${backfillOnly.length} reachable only by backfill; ` +
      `${entries.filter((e) => e.action === "complete").length} complete.`,
  };
}

function priorityRank(priority: PlanPriority): number {
  return priority === "urgent" ? 0 : priority === "normal" ? 1 : 2;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
