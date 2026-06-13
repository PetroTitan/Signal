/**
 * Phase B7 — scheduler heartbeat, derived from REAL state only.
 *
 * Signal's scheduler is a Vercel cron that hits /api/scheduler/tick on
 * a fixed interval. This module computes an operator-facing health
 * snapshot from values that are all real and observable WITHOUT a new
 * table:
 *
 *   - scheduledCount   : execution_items in `scheduled` (caller counts)
 *   - retryQueueCount  : `scheduled` AND attempt_count >= 1 (Phase A)
 *   - runningNowCount  : execution_items in `running` (claimed; >0 means
 *                        a tick is mid-publish OR a stale claim exists)
 *   - nextExpectedTick : derived from the cron cadence (next boundary)
 *   - lastObservedPublishAt: most recent publish_history.finished_at —
 *                        a PROXY for "scheduler did work", NOT a tick
 *                        log. Labeled honestly; never presented as the
 *                        tick timestamp.
 *
 * Authoritative last-successful / last-failed tick timestamps require
 * persisting each tick run (a `scheduler_runs` table) — out of scope
 * here (no migration); documented as a follow-up. No synthetic values.
 *
 * Pure module — no I/O.
 */

export interface SchedulerHealthInput {
  scheduledCount: number;
  retryQueueCount: number;
  runningNowCount: number;
  /** Most recent successful publish (ISO), or null. Proxy signal. */
  lastObservedPublishAtIso: string | null;
  /** Cron cadence; Signal runs every 5 minutes (vercel.json). */
  tickIntervalMinutes?: number;
  now: Date;
}

export type SchedulerHealthState = "idle" | "active" | "running" | "backlogged";

export interface SchedulerHealth {
  state: SchedulerHealthState;
  scheduledCount: number;
  retryQueueCount: number;
  runningNowCount: number;
  /** ISO of the next cron boundary at/after `now`. */
  nextExpectedTickIso: string;
  /** Whole minutes until the next tick (>= 0). */
  minutesToNextTick: number;
  lastObservedPublishAtIso: string | null;
  /** One-line operator summary built from the real numbers. */
  summary: string;
}

const DEFAULT_INTERVAL = 5;

/** Next cron boundary at/after `now` for a fixed-minute cadence. */
export function nextTickBoundary(now: Date, intervalMinutes: number): Date {
  const interval = Math.max(1, Math.floor(intervalMinutes));
  const ms = interval * 60_000;
  // Align to wall-clock minute boundaries (cron fires on */N minutes).
  const floored = Math.floor(now.getTime() / ms) * ms;
  let next = floored + ms;
  // If we're exactly on a boundary, the next one is a full interval out.
  if (next <= now.getTime()) next += ms;
  return new Date(next);
}

export function computeSchedulerHealth(
  input: SchedulerHealthInput,
): SchedulerHealth {
  const interval = input.tickIntervalMinutes ?? DEFAULT_INTERVAL;
  const nextTick = nextTickBoundary(input.now, interval);
  const minutesToNextTick = Math.max(
    0,
    Math.round((nextTick.getTime() - input.now.getTime()) / 60_000),
  );

  let state: SchedulerHealthState;
  if (input.runningNowCount > 0) state = "running";
  else if (input.scheduledCount === 0) state = "idle";
  // "backlogged" = far more queued than one tick's batch (10) can clear.
  else if (input.scheduledCount > 10) state = "backlogged";
  else state = "active";

  const summaryParts: string[] = [];
  summaryParts.push(
    `${input.scheduledCount} scheduled${input.retryQueueCount > 0 ? ` (${input.retryQueueCount} retrying)` : ""}`,
  );
  if (input.runningNowCount > 0) {
    summaryParts.push(`${input.runningNowCount} publishing now`);
  }
  summaryParts.push(
    minutesToNextTick <= 0
      ? "next run due now"
      : `next run in ~${minutesToNextTick}m`,
  );

  return {
    state,
    scheduledCount: input.scheduledCount,
    retryQueueCount: input.retryQueueCount,
    runningNowCount: input.runningNowCount,
    nextExpectedTickIso: nextTick.toISOString(),
    minutesToNextTick,
    lastObservedPublishAtIso: input.lastObservedPublishAtIso,
    summary: summaryParts.join(" · "),
  };
}
