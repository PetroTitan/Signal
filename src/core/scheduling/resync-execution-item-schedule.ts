/**
 * Decide whether an active execution_item should follow its
 * weekly_plan_items.scheduled_at when the operator updates it.
 *
 * Pure module — no I/O, no Supabase, no React. The server-side
 * orchestrator (resync-execution-item-schedule.server.ts) wires the
 * classifier to the repositories and the activity log.
 *
 * Background
 * ----------
 * Pre-fix, changing the schedule in the UI only updated
 * weekly_plan_items.scheduled_at. Once an execution_item existed for
 * the plan_item, its own scheduled_at was frozen. The scheduler reads
 * execution_items.scheduled_at, so the new operator time silently had
 * no effect on when the post actually published.
 *
 * Rules
 * -----
 * For each active execution_item belonging to the plan_item:
 *
 *   - resync           — status in { pending_authorization,
 *                        authorized, scheduled } AND the next ISO is
 *                        non-null AND differs from current.
 *   - skip_no_change   — next ISO matches current scheduled_at.
 *   - skip_clear       — next ISO is null. Clearing the schedule on
 *                        an active execution_item is unschedule, not
 *                        reschedule; handled by removePlanItemAction.
 *   - skip_running     — status is "running"; the runner is mid-flight
 *                        and a resync would race the publish call.
 *   - skip_ready       — status in { ready, ready_for_manual_publish };
 *                        the runner has claimed the row for this tick.
 *   - skip_paused      — status is "paused"; operator must use
 *                        Schedule retry which creates a fresh
 *                        execution_item.
 *   - skip_failed      — status is "failed"; same as paused, history
 *                        is preserved and a fresh execution_item is
 *                        created via the retry path.
 *   - skip_terminal    — status is one of FINAL_ITEM_STATUSES (or
 *                        an unknown future status). History rows must
 *                        not be mutated silently.
 */

import type {
  ExecutionItem,
  ExecutionItemStatus,
} from "@/core/execution-engine";
import { FINAL_ITEM_STATUSES } from "@/core/execution-engine";

export type ResyncDecision =
  | {
      action: "resync";
      previousScheduledAt: string | null;
      nextScheduledAt: string;
    }
  | { action: "skip_no_change" }
  | { action: "skip_clear" }
  | { action: "skip_running" }
  | { action: "skip_ready" }
  | { action: "skip_paused" }
  | { action: "skip_failed" }
  | { action: "skip_terminal"; status: ExecutionItemStatus };

/**
 * Statuses for which an in-place schedule resync is safe. The runner
 * has not yet claimed the row, so updating scheduled_at simply moves
 * the next-tick eligibility window.
 */
export const RESYNC_ELIGIBLE_STATUSES: ReadonlySet<ExecutionItemStatus> =
  new Set(["pending_authorization", "authorized", "scheduled"]);

const RUNNER_CLAIMED_STATUSES: ReadonlySet<ExecutionItemStatus> = new Set([
  "ready",
  "ready_for_manual_publish",
]);

export function classifyResyncTarget(
  ei: Pick<ExecutionItem, "status" | "scheduledAt">,
  nextScheduledAtIso: string | null,
): ResyncDecision {
  if (nextScheduledAtIso === null) return { action: "skip_clear" };
  if (ei.status === "running") return { action: "skip_running" };
  if (ei.status === "paused") return { action: "skip_paused" };
  if (ei.status === "failed") return { action: "skip_failed" };
  if (RUNNER_CLAIMED_STATUSES.has(ei.status)) return { action: "skip_ready" };
  if (FINAL_ITEM_STATUSES.has(ei.status)) {
    return { action: "skip_terminal", status: ei.status };
  }
  if (!RESYNC_ELIGIBLE_STATUSES.has(ei.status)) {
    return { action: "skip_terminal", status: ei.status };
  }
  if (ei.scheduledAt === nextScheduledAtIso) {
    return { action: "skip_no_change" };
  }
  return {
    action: "resync",
    previousScheduledAt: ei.scheduledAt ?? null,
    nextScheduledAt: nextScheduledAtIso,
  };
}

/**
 * One-line operator-facing copy for skip outcomes. The orchestrator
 * surfaces this as the `message` on the returned result so the action
 * caller can pass it back to the UI / MCP response without inventing
 * its own wording.
 */
export function describeSkip(decision: ResyncDecision): string | null {
  switch (decision.action) {
    case "skip_running":
      return "Publish is in flight — wait for it to finish, then retry.";
    case "skip_ready":
      return "This post has been claimed by the scheduler for the next tick.";
    case "skip_paused":
      return "Last attempt was paused. Use Schedule retry to create a fresh publish.";
    case "skip_failed":
      return "Last attempt failed. Use Schedule retry to create a fresh publish.";
    case "skip_terminal":
      return `Execution history is ${decision.status} — start a new publish to change the time.`;
    case "skip_no_change":
    case "skip_clear":
    case "resync":
      return null;
  }
}
