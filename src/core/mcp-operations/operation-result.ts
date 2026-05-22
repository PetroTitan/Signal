import type { McpOperationType } from "./operation-types";

/**
 * Generic shape every MCP-operation handler returns. Field-mapping
 * payloads vary per operation; the envelope is constant.
 */
export interface McpOperationOk<T> {
  ok: true;
  operationType: McpOperationType;
  payload: T;
  notes: string[];
  durationMs: number;
}

export interface McpOperationFail {
  ok: false;
  operationType: McpOperationType;
  error: string;
  /** Short discriminator; safe to log. */
  errorCode:
    | "not_authenticated"
    | "not_authorized"
    | "validation_failed"
    | "low_confidence"
    | "blocked_by_policy"
    | "upstream_failure"
    | "unknown";
  notes: string[];
  durationMs: number;
}

export type McpOperationResult<T> = McpOperationOk<T> | McpOperationFail;

export function mcpOk<T>(
  operationType: McpOperationType,
  payload: T,
  options: { notes?: string[]; durationMs?: number } = {},
): McpOperationOk<T> {
  return {
    ok: true,
    operationType,
    payload,
    notes: options.notes ?? [],
    durationMs: options.durationMs ?? 0,
  };
}

export function mcpFail(
  operationType: McpOperationType,
  error: string,
  errorCode: McpOperationFail["errorCode"],
  options: { notes?: string[]; durationMs?: number } = {},
): McpOperationFail {
  return {
    ok: false,
    operationType,
    error,
    errorCode,
    notes: options.notes ?? [],
    durationMs: options.durationMs ?? 0,
  };
}
