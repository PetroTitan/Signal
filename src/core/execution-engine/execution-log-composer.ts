/**
 * Compose execution log rows from authorization results and runner
 * decisions. The composer is pure — it does not write to the DB. The
 * repository layer takes a `ComposedLog` and inserts it.
 */

import type { AuthorizationResult } from "@/core/weekly-contract";
import type {
  ExecutionLogSeverity,
} from "./execution-types";
import type { ExecutionLogEvent } from "./execution-events";

export interface ComposedLog {
  workspaceId: string;
  queueId: string | null;
  executionItemId: string | null;
  eventType: ExecutionLogEvent;
  severity: ExecutionLogSeverity;
  message: string;
  metadata: Record<string, unknown>;
}

export function composeAuthorizationLog(input: {
  workspaceId: string;
  queueId: string;
  executionItemId: string;
  result: AuthorizationResult;
}): ComposedLog {
  const { workspaceId, queueId, executionItemId, result } = input;
  const allowed = result.severity === "allow";
  return {
    workspaceId,
    queueId,
    executionItemId,
    eventType: allowed ? "item.authorization_allowed" : "item.authorization_denied",
    severity: allowed ? "info" : result.severity === "hard_block" ? "error" : "warning",
    message: allowed
      ? "Item authorized under the active contract."
      : `Item ${result.severity} — ${result.reasonCode}${
          result.reasonDetail ? `: ${result.reasonDetail}` : ""
        }.`,
    metadata: {
      authorization: {
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        severity: result.severity,
        suggestedAction: result.suggestedAction,
      },
    },
  };
}

export function composeDryRunLog(input: {
  workspaceId: string;
  queueId: string;
  executionItemId: string;
  dryRunAction: string;
  message: string;
  metadata?: Record<string, unknown>;
}): ComposedLog {
  return {
    workspaceId: input.workspaceId,
    queueId: input.queueId,
    executionItemId: input.executionItemId,
    eventType: "item.dry_run_finished",
    severity: "info",
    message: input.message,
    metadata: { dryRunAction: input.dryRunAction, ...(input.metadata ?? {}) },
  };
}

export function composeQueueLog(input: {
  workspaceId: string;
  queueId: string;
  eventType: ExecutionLogEvent;
  message: string;
  severity?: ExecutionLogSeverity;
  metadata?: Record<string, unknown>;
}): ComposedLog {
  return {
    workspaceId: input.workspaceId,
    queueId: input.queueId,
    executionItemId: null,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    message: input.message,
    metadata: input.metadata ?? {},
  };
}

export function composeItemLog(input: {
  workspaceId: string;
  queueId: string;
  executionItemId: string;
  eventType: ExecutionLogEvent;
  message: string;
  severity?: ExecutionLogSeverity;
  metadata?: Record<string, unknown>;
}): ComposedLog {
  return {
    workspaceId: input.workspaceId,
    queueId: input.queueId,
    executionItemId: input.executionItemId,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    message: input.message,
    metadata: input.metadata ?? {},
  };
}
