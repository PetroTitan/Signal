/**
 * Execution state machines for queues and items.
 *
 * Transitions are explicit and return typed `Result` values rather
 * than throwing — the runner inspects the verdict and decides what to
 * do.
 */

import type {
  ExecutionItemStatus,
  ExecutionQueueStatus,
} from "./execution-types";
import { isItemFinal, isQueueFinal } from "./execution-status";

export class ExecutionStateError extends Error {
  constructor(
    message: string,
    public readonly from: string,
    public readonly to: string,
    public readonly kind: "queue" | "item",
  ) {
    super(message);
    this.name = "ExecutionStateError";
  }
}

export type TransitionVerdict<T extends string> =
  | { ok: true; from: T; to: T }
  | { ok: false; from: T; to: T; error: ExecutionStateError };

const ITEM_TRANSITIONS: Record<
  ExecutionItemStatus,
  ReadonlyArray<ExecutionItemStatus>
> = {
  pending_authorization: [
    "authorized",
    "blocked",
    "backlogged",
    "skipped",
    "cancelled",
  ],
  authorized: [
    "scheduled",
    "ready",
    "running",
    "completed",
    "backlogged",
    "skipped",
    "blocked",
    "paused",
    "cancelled",
  ],
  scheduled: ["ready", "running", "paused", "backlogged", "cancelled"],
  ready: [
    "ready_for_manual_publish",
    "running",
    "paused",
    "backlogged",
    "cancelled",
  ],
  ready_for_manual_publish: [
    "ready",
    "running",
    "paused",
    "backlogged",
    "cancelled",
  ],
  running: ["completed", "failed", "paused"],
  paused: ["ready", "scheduled", "backlogged", "cancelled"],
  // Final states
  completed: [],
  blocked: [],
  backlogged: [],
  skipped: [],
  failed: ["ready", "scheduled", "cancelled", "backlogged"],
  cancelled: [],
};

const QUEUE_TRANSITIONS: Record<
  ExecutionQueueStatus,
  ReadonlyArray<ExecutionQueueStatus>
> = {
  draft: ["ready", "cancelled"],
  ready: ["running", "paused", "cancelled"],
  running: ["paused", "completed", "failed"],
  paused: ["running", "ready", "cancelled"],
  completed: [],
  cancelled: [],
  failed: ["ready", "cancelled"],
};

export function canTransitionItem(
  from: ExecutionItemStatus,
  to: ExecutionItemStatus,
): boolean {
  if (from === to) return false;
  if (isItemFinal(from)) return false;
  return ITEM_TRANSITIONS[from].includes(to);
}

export function transitionItem(
  from: ExecutionItemStatus,
  to: ExecutionItemStatus,
): TransitionVerdict<ExecutionItemStatus> {
  if (!canTransitionItem(from, to)) {
    return {
      ok: false,
      from,
      to,
      error: new ExecutionStateError(
        `Invalid execution_item transition: ${from} → ${to}`,
        from,
        to,
        "item",
      ),
    };
  }
  return { ok: true, from, to };
}

export function canTransitionQueue(
  from: ExecutionQueueStatus,
  to: ExecutionQueueStatus,
): boolean {
  if (from === to) return false;
  if (isQueueFinal(from)) return false;
  return QUEUE_TRANSITIONS[from].includes(to);
}

export function transitionQueue(
  from: ExecutionQueueStatus,
  to: ExecutionQueueStatus,
): TransitionVerdict<ExecutionQueueStatus> {
  if (!canTransitionQueue(from, to)) {
    return {
      ok: false,
      from,
      to,
      error: new ExecutionStateError(
        `Invalid execution_queue transition: ${from} → ${to}`,
        from,
        to,
        "queue",
      ),
    };
  }
  return { ok: true, from, to };
}
