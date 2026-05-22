import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  McpOperationRunInsert,
  McpOperationRunRow,
  McpOperationRunUpdate,
} from "@/lib/supabase/types";
import {
  getPermission,
  type McpOperationType,
  type OperationRunStatus,
} from "@/core/mcp-operations";
import { fromPostgres, notFound } from "@/repositories/errors";

export interface McpOperationRunRecord {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  operationType: string;
  riskLevel: string;
  approvalMode: string;
  status: string;
  inputSummary: string | null;
  outputSummary: string | null;
  errorSummary: string | null;
  requiresUserApproval: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toRun(row: McpOperationRunRow): McpOperationRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    operationType: row.operation_type,
    riskLevel: row.risk_level,
    approvalMode: row.approval_mode,
    status: row.status,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    errorSummary: row.error_summary,
    requiresUserApproval: row.requires_user_approval,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OpenOperationRunInput {
  workspaceId: string;
  operationType: McpOperationType;
  initialStatus: OperationRunStatus;
  inputSummary?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a new mcp_operation_runs row from the runner's initial
 * decision. Populates risk_level / approval_mode from the permission
 * table so the audit row stays in lock-step with code.
 */
export async function openOperationRun(
  input: OpenOperationRunInput,
): Promise<McpOperationRunRecord> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const permission = getPermission(input.operationType);
  const insert: McpOperationRunInsert = {
    workspace_id: input.workspaceId,
    actor_user_id: user?.id ?? null,
    operation_type: input.operationType,
    risk_level: permission.riskLevel,
    approval_mode: permission.approvalMode,
    status: input.initialStatus,
    input_summary: input.inputSummary ?? null,
    requires_user_approval: permission.approvalMode !== "no_approval_needed",
    metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) {
    throw fromPostgres(error, "Failed to open MCP operation run.");
  }
  return toRun(data as unknown as McpOperationRunRow);
}

export interface CloseOperationRunInput {
  workspaceId: string;
  runId: string;
  status: OperationRunStatus;
  outputSummary?: string | null;
  errorSummary?: string | null;
  metadata?: Record<string, unknown>;
}

export async function closeOperationRun(
  input: CloseOperationRunInput,
): Promise<McpOperationRunRecord> {
  const supabase = createSupabaseServerClient();
  const patch: McpOperationRunUpdate = { status: input.status };
  if (input.outputSummary !== undefined) patch.output_summary = input.outputSummary;
  if (input.errorSummary !== undefined) patch.error_summary = input.errorSummary;
  if (input.metadata !== undefined) patch.metadata = input.metadata;

  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.runId)
    .select("*")
    .single();
  if (error || !data) {
    throw fromPostgres(error, "Failed to close MCP operation run.");
  }
  return toRun(data as unknown as McpOperationRunRow);
}

export async function approveOperationRun(input: {
  workspaceId: string;
  runId: string;
  approvedBy: string;
}): Promise<McpOperationRunRecord> {
  const supabase = createSupabaseServerClient();
  const patch: McpOperationRunUpdate = {
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: input.approvedBy,
  };
  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.runId)
    .select("*")
    .single();
  if (error || !data) {
    throw fromPostgres(error, "Failed to approve MCP operation run.");
  }
  return toRun(data as unknown as McpOperationRunRow);
}

export async function listRecentOperationRuns(
  workspaceId: string,
  limit = 30,
): Promise<McpOperationRunRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list MCP operation runs.");
  return ((data ?? []) as unknown as McpOperationRunRow[]).map(toRun);
}

export async function listPendingApprovals(
  workspaceId: string,
  limit = 30,
): Promise<McpOperationRunRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list pending MCP approvals.");
  return ((data ?? []) as unknown as McpOperationRunRow[]).map(toRun);
}

export async function rejectOperationRun(input: {
  workspaceId: string;
  runId: string;
  reason?: string;
}): Promise<McpOperationRunRecord> {
  const supabase = createSupabaseServerClient();
  const patch: McpOperationRunUpdate = {
    status: "rejected",
    error_summary: input.reason ?? null,
  };
  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.runId)
    .select("*")
    .single();
  if (error || !data) {
    throw fromPostgres(error, "Failed to reject MCP operation run.");
  }
  return toRun(data as unknown as McpOperationRunRow);
}

export async function getOperationRunById(
  workspaceId: string,
  runId: string,
): Promise<McpOperationRunRecord> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load MCP operation run.");
  if (!data) throw notFound("MCP operation run");
  return toRun(data as unknown as McpOperationRunRow);
}
