import "server-only";
import {
  closeOperationRun,
  openOperationRun,
} from "@/repositories/admin-operations/mcp-operation-repository";
import type { McpOperationRunRecord } from "@/repositories/admin-operations/mcp-operation-repository";
import type { McpOperationType } from "@/core/mcp-operations";
import type {
  BridgeRequestType,
  OperatorBridgeRequest,
} from "@/core/operator-bridge";

/**
 * Phase E2.8 — bridges to the mcp_operation_runs table.
 *
 * Each operator-bridge request optionally links to an mcp_operation_runs
 * row. The mapping below picks the closest existing operation type for
 * each request kind. When the bridge surface gains operation types of
 * its own, this map gets new entries.
 */

const REQUEST_TO_OPERATION: Record<BridgeRequestType, McpOperationType> = {
  repo_check: "smoke_test_run",
  db_check: "db_integrity_check",
  rls_check: "rls_check",
  migration_review: "migration_plan_prepare",
  pr_readiness_review: "pr_readiness_check",
  import_mapping: "product_profile_suggest",
  smoke_test: "smoke_test_run",
  deployment_review: "deployment_readiness_check",
  architecture_audit: "smoke_test_run",
};

export function operationTypeForRequest(
  requestType: BridgeRequestType,
): McpOperationType {
  return REQUEST_TO_OPERATION[requestType];
}

export async function openOperationForBridgeRequest(input: {
  workspaceId: string;
  request: OperatorBridgeRequest;
}): Promise<McpOperationRunRecord> {
  return openOperationRun({
    workspaceId: input.workspaceId,
    operationType: operationTypeForRequest(input.request.requestType),
    initialStatus:
      input.request.approvalMode === "no_approval_needed"
        ? "running"
        : "pending_approval",
    inputSummary: `Operator bridge: ${input.request.title}`,
    metadata: {
      bridge_request_id: input.request.id,
      assistant_type: input.request.assistantType,
      request_type: input.request.requestType,
    },
  });
}

export async function closeOperationForBridgeRequest(input: {
  workspaceId: string;
  operationRunId: string;
  status: "completed" | "failed" | "rejected";
  outputSummary?: string | null;
  errorSummary?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<McpOperationRunRecord> {
  return closeOperationRun({
    workspaceId: input.workspaceId,
    runId: input.operationRunId,
    status: input.status,
    outputSummary: input.outputSummary,
    errorSummary: input.errorSummary,
    metadata: input.metadata,
  });
}
