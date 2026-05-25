import "server-only";

/**
 * Server-side orchestrator for the schedule-resync flow.
 *
 * Inputs: workspaceId, planItemId, the operator-facing next ISO, and a
 * source tag ("ui" | "mcp"). The orchestrator:
 *
 *   1. Loads all execution_items for the plan_item.
 *   2. Classifies each via `classifyResyncTarget` (pure module).
 *   3. For each "resync" decision, calls
 *      `applyExecutionItemScheduleResync` (single repo write that
 *      preserves contract_id / metadata and stamps audit fields).
 *   4. Records an execution_log row with
 *      `event_type = "item.schedule_resynced"` and
 *      `metadata.reason_code = "schedule_resynced"`.
 *   5. Returns a typed summary so callers (saveScheduleAction,
 *      updatePlanItemAction, the MCP schedule_publish tool) can pass
 *      a clear operator-facing message back to the UI.
 *
 * The orchestrator NEVER:
 *   - calls a platform publish API
 *   - issues raw SQL (uses the repository layer only)
 *   - deletes execution history
 *   - mutates terminal rows
 *   - touches platform adapters / cross-platform side effects
 */

import {
  applyExecutionItemScheduleResync,
  listExecutionItemsByPlanItemIds,
} from "@/repositories/execution-item-repository";
import { recordLog } from "@/repositories/execution-log-repository";
import {
  classifyResyncTarget,
  describeSkip,
  type ResyncDecision,
} from "./resync-execution-item-schedule";

export type ResyncMode =
  | "rescheduled_active_execution_item"
  | "no_active_execution_item"
  | "no_change"
  | "cleared"
  | "blocked";

export interface ResyncOutcome {
  mode: ResyncMode;
  /** The execution_item that was (or would have been) rescheduled. */
  executionItemId: string | null;
  /** Operator-facing one-line message. null when nothing to say. */
  message: string | null;
  /** Classifier decision — useful for tests and audit trail. */
  decision: ResyncDecision | null;
}

/**
 * Resync the active execution_item (if any) for a plan_item to match
 * the operator's next scheduled_at. See file header for behavior.
 */
export async function resyncActiveExecutionItemSchedule(input: {
  workspaceId: string;
  planItemId: string;
  /** Null means "schedule cleared"; the orchestrator treats this as
   *  a no-op so unschedule continues to flow through the existing
   *  removePlanItemAction path. */
  nextScheduledAtIso: string | null;
  source: "ui" | "mcp";
}): Promise<ResyncOutcome> {
  if (input.nextScheduledAtIso === null) {
    return {
      mode: "cleared",
      executionItemId: null,
      message: null,
      decision: { action: "skip_clear" },
    };
  }

  const all = await listExecutionItemsByPlanItemIds(input.workspaceId, [
    input.planItemId,
  ]);
  if (all.length === 0) {
    return {
      mode: "no_active_execution_item",
      executionItemId: null,
      message: null,
      decision: null,
    };
  }

  // The repository orders by scheduled_at ascending; the "current"
  // active row for our purposes is the newest non-terminal one. We
  // classify all of them so terminal history is preserved in the
  // returned summary, but we only act on the first eligible match.
  let actedOn: { id: string; decision: ResyncDecision } | null = null;
  let lastSkip: { id: string; decision: ResyncDecision } | null = null;

  for (const ei of all) {
    const decision = classifyResyncTarget(ei, input.nextScheduledAtIso);
    if (decision.action === "resync" && actedOn === null) {
      actedOn = { id: ei.id, decision };
      break;
    }
    if (
      decision.action === "skip_running" ||
      decision.action === "skip_ready" ||
      decision.action === "skip_paused" ||
      decision.action === "skip_failed" ||
      decision.action === "skip_terminal"
    ) {
      // Remember the first blocker so we can surface a message if no
      // eligible row exists.
      if (lastSkip === null) {
        lastSkip = { id: ei.id, decision };
      }
    }
  }

  if (actedOn === null) {
    if (lastSkip !== null) {
      return {
        mode: "blocked",
        executionItemId: lastSkip.id,
        message: describeSkip(lastSkip.decision),
        decision: lastSkip.decision,
      };
    }
    // All matches were skip_no_change / skip_clear — no message.
    return {
      mode: "no_change",
      executionItemId: null,
      message: null,
      decision: null,
    };
  }

  if (actedOn.decision.action !== "resync") {
    // Defensive: actedOn is only set when decision.action === "resync".
    // This branch is unreachable, narrows the type for TypeScript.
    return {
      mode: "no_change",
      executionItemId: actedOn.id,
      message: null,
      decision: actedOn.decision,
    };
  }

  const updated = await applyExecutionItemScheduleResync({
    workspaceId: input.workspaceId,
    itemId: actedOn.id,
    nextScheduledAt: actedOn.decision.nextScheduledAt,
    previousScheduledAt: actedOn.decision.previousScheduledAt,
    source: input.source,
  });

  // Best-effort log. If logging fails we still report success — the
  // schedule mutation is the load-bearing side effect; the log is
  // observability only. Failure is surfaced via console.error.
  try {
    await recordLog({
      workspaceId: input.workspaceId,
      queueId: updated.queueId,
      executionItemId: updated.id,
      eventType: "item.schedule_resynced",
      severity: "info",
      message: `[scheduling] resynced execution_item.scheduled_at to ${actedOn.decision.nextScheduledAt} from plan_item update (${input.source})`,
      metadata: {
        reason_code: "schedule_resynced",
        previous_scheduled_at: actedOn.decision.previousScheduledAt,
        next_scheduled_at: actedOn.decision.nextScheduledAt,
        source: input.source,
        plan_item_id: input.planItemId,
      },
    });
  } catch (err) {
    console.error("[resyncActiveExecutionItemSchedule] log failed", err);
  }

  return {
    mode: "rescheduled_active_execution_item",
    executionItemId: actedOn.id,
    message: null,
    decision: actedOn.decision,
  };
}
