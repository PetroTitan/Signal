import {
  evaluateApproval,
  type ApprovalDecision,
  type ApprovalInput,
} from "./approval-gates";
import { getPermission } from "./operation-permissions";
import type { McpOperationType } from "./operation-types";
import {
  mcpFail,
  mcpOk,
  type McpOperationResult,
} from "./operation-result";

/**
 * Status terms used in `mcp_operation_runs`. Kept in sync with the
 * Postgres CHECK constraint in the migration.
 */
export const OPERATION_RUN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "running",
  "completed",
  "failed",
  "rejected",
  "blocked",
] as const;
export type OperationRunStatus = (typeof OPERATION_RUN_STATUSES)[number];

export interface OperationRunInput<T> {
  operationType: McpOperationType;
  /** Short, audit-safe summary of the inputs. Never include
   *  screenshots, passwords, or other sensitive material. */
  inputSummary?: string;
  approval?: ApprovalInput;
  /** Workhorse: the actual operation body. Only invoked once the
   *  approval gate clears. */
  execute: () => Promise<T>;
  /** Optional textual summary of a successful payload. */
  describeOutput?: (payload: T) => string;
}

export interface OperationRunResult<T> {
  decision: ApprovalDecision;
  /** Initial run status as derived from the decision. May be
   *  updated by the runner if the body fails. */
  status: OperationRunStatus;
  result: McpOperationResult<T> | null;
  /** Human-readable summary suitable for `output_summary`. */
  outputSummary: string | null;
}

/**
 * Local, in-process operation runner. Persistence to
 * `mcp_operation_runs` lives in the repository layer; this module
 * owns the decision and timing without taking a DB dependency, so it
 * stays pure and unit-testable.
 *
 * If the approval gate refuses, the runner does not invoke `execute`.
 * The caller is expected to persist the decision and surface it to
 * the user.
 */
export async function runOperation<T>(
  input: OperationRunInput<T>,
): Promise<OperationRunResult<T>> {
  const decision = evaluateApproval(input.operationType, input.approval);

  if (!decision.allowed) {
    const reason =
      decision.reason === "blocked"
        ? "Operation is blocked by policy."
        : decision.reason === "approval_required"
          ? "User approval required before this operation can run."
          : "Explicit text confirmation required before this operation can run.";
    return {
      decision,
      status: decision.status,
      result: mcpFail(input.operationType, reason, "blocked_by_policy"),
      outputSummary: null,
    };
  }

  const started = Date.now();
  try {
    const payload = await input.execute();
    const result = mcpOk(input.operationType, payload, {
      durationMs: Date.now() - started,
    });
    const summary = input.describeOutput
      ? input.describeOutput(payload)
      : `Operation ${input.operationType} completed.`;
    return {
      decision,
      status: "completed",
      result,
      outputSummary: summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return {
      decision,
      status: "failed",
      result: mcpFail(input.operationType, message, "upstream_failure", {
        durationMs: Date.now() - started,
      }),
      outputSummary: null,
    };
  }
}

/**
 * Convenience wrapper for callers that want to know how an operation
 * would be classified before invoking it.
 */
export function explainOperation(operationType: McpOperationType) {
  const permission = getPermission(operationType);
  return {
    riskLevel: permission.riskLevel,
    approvalMode: permission.approvalMode,
    writesDatabase: permission.writesDatabase,
    writesRepository: permission.writesRepository,
    touchesProduction: permission.touchesProduction,
    reversible: permission.reversible,
    requiresMcpTool: permission.requiresMcpTool,
  };
}
