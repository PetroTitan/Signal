/**
 * Canonical "what time is this post actually going to publish?"
 * resolver.
 *
 * Background
 * ----------
 * Signal stores two related timestamps:
 *
 *   - weekly_plan_items.scheduled_at — editorial / planning time.
 *     This is what the operator sets in the compose sheet or the
 *     reschedule popover. It exists for every approved-and-scheduled
 *     item.
 *   - execution_items.scheduled_at — the actual publish trigger.
 *     The scheduler reads this column to decide whether to call the
 *     platform's transport. It exists only once an execution_item
 *     has been created (post-approval).
 *
 * Once an active execution_item exists, IT is the source of truth
 * for "when does this publish?" The plan_item value is editorial
 * intent; the execution_item value is what the cron will fire on.
 * `fix/reschedule-active-execution-item` (PR #99) makes sure the
 * two stay in sync when the operator edits the schedule — but the
 * UI was still reading the plan_item value, so an operator who
 * believed the divergence existed had no way to tell from the card.
 *
 * This module gives the rest of the codebase one answer:
 * `getEffectivePublishSchedule(planItem, exec?)` returns the
 * authoritative timestamp + a `source` tag + an `isDiverged` flag.
 *
 * Active execution statuses (canonical with PR #99's
 * RESYNC_ELIGIBLE_STATUSES): pending_authorization, authorized,
 * scheduled. Terminal / runner-claimed / retry-required statuses
 * fall back to the editorial time.
 */

import type { ExecutionItemStatus } from "@/core/execution-engine";

export interface PlanItemForSchedule {
  scheduledAt: string | null;
}

export interface ExecutionItemForSchedule {
  status: ExecutionItemStatus | string;
  scheduledAt: string | null;
}

export type EffectiveSource =
  | "execution_item"
  | "weekly_plan_item"
  | "none";

export interface EffectivePublishSchedule {
  /** weekly_plan_items.scheduled_at — operator's editorial intent. */
  editorialScheduledAt: string | null;
  /** Active execution_items.scheduled_at, or null when none active. */
  executionScheduledAt: string | null;
  /** The effective publish time:
   *  - execution_item time if an active execution_item exists
   *  - else editorial time
   *  - else null. */
  effectiveScheduledAt: string | null;
  /** Where the effective time came from. */
  source: EffectiveSource;
  /** True when both timestamps exist AND differ (>=1 second). After
   *  PR #99 resync this should normally be false; surfacing it is a
   *  belt-and-braces signal for the operator. */
  isDiverged: boolean;
  /** |execution − editorial| in milliseconds, null when either is
   *  missing. Useful for log metadata and for picking a UI tier
   *  (chip vs. amber banner) based on magnitude. */
  divergenceMs: number | null;
}

/**
 * Statuses for which the execution_item is "active" — i.e. its
 * scheduled_at is what the scheduler will actually use. Mirrors
 * RESYNC_ELIGIBLE_STATUSES from
 * `src/core/scheduling/resync-execution-item-schedule.ts` so both
 * helpers agree on the definition of active.
 */
export const ACTIVE_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "pending_authorization",
  "authorized",
  "scheduled",
]);

export function getEffectivePublishSchedule(
  planItem: PlanItemForSchedule,
  exec?: ExecutionItemForSchedule | null,
): EffectivePublishSchedule {
  const editorial = planItem.scheduledAt ?? null;
  const execActive =
    exec && ACTIVE_EXECUTION_STATUSES.has(exec.status) ? exec : null;
  const execTime = execActive?.scheduledAt ?? null;

  const divergenceMs =
    editorial !== null && execTime !== null
      ? Math.abs(
          new Date(execTime).getTime() - new Date(editorial).getTime(),
        )
      : null;
  // 1-second tolerance: round-tripping through Postgres can drop sub-
  // second precision in either column depending on the write path,
  // and the operator UI shows minute precision anyway.
  const isDiverged = divergenceMs !== null && divergenceMs >= 1000;

  let source: EffectiveSource;
  let effective: string | null;
  if (execActive && execTime !== null) {
    source = "execution_item";
    effective = execTime;
  } else if (editorial !== null) {
    source = "weekly_plan_item";
    effective = editorial;
  } else {
    source = "none";
    effective = null;
  }

  return {
    editorialScheduledAt: editorial,
    executionScheduledAt: execTime,
    effectiveScheduledAt: effective,
    source,
    isDiverged,
    divergenceMs,
  };
}

/**
 * Compact label for the source chip on the card / sheet footer.
 * Keep the wording short — the divergence warning carries the
 * explanation copy.
 */
export function describeEffectiveSource(
  schedule: Pick<EffectivePublishSchedule, "source" | "effectiveScheduledAt">,
): string {
  if (schedule.source === "execution_item") return "Publish trigger: execution item";
  if (schedule.source === "weekly_plan_item") return "Planning time only";
  return "No schedule";
}
