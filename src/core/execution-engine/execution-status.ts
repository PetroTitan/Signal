/**
 * Status helpers shared by the state machine and the UI.
 */

import type {
  ExecutionItemStatus,
  ExecutionQueueStatus,
} from "./execution-types";
import { FINAL_ITEM_STATUSES, FINAL_QUEUE_STATUSES } from "./execution-types";

export function isItemFinal(status: ExecutionItemStatus): boolean {
  return FINAL_ITEM_STATUSES.has(status);
}

export function isQueueFinal(status: ExecutionQueueStatus): boolean {
  return FINAL_QUEUE_STATUSES.has(status);
}

export function isQueueLive(status: ExecutionQueueStatus): boolean {
  return (
    status === "draft" ||
    status === "ready" ||
    status === "running" ||
    status === "paused"
  );
}

export function isItemReadyForExecution(status: ExecutionItemStatus): boolean {
  return status === "authorized" || status === "scheduled" || status === "ready";
}
