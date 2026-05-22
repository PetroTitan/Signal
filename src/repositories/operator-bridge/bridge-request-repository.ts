import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  OperatorBridgeRequestInsert,
  OperatorBridgeRequestRow,
  OperatorBridgeRequestUpdate,
} from "@/lib/supabase/types";
import type {
  BridgeApprovalMode,
  BridgeAssistantType,
  BridgeRequestStatus,
  BridgeRequestType,
  BridgeRiskLevel,
  OperatorBridgeRequest,
} from "@/core/operator-bridge";
import { assertTransition, BRIDGE_NONCE_TTL_MS } from "@/core/operator-bridge";
import { fromPostgres, notAuthenticated, notFound } from "../errors";

function toRequest(row: OperatorBridgeRequestRow): OperatorBridgeRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    operationRunId: row.operation_run_id,
    requestedBy: row.requested_by,
    assignedTo: row.assigned_to,
    assistantType: row.assistant_type,
    requestType: row.request_type,
    riskLevel: row.risk_level,
    approvalMode: row.approval_mode,
    status: row.status,
    title: row.title,
    taskPrompt: row.task_prompt,
    expectedResultSchema: row.expected_result_schema,
    allowedCapabilities: row.allowed_capabilities,
    blockedCapabilities: row.blocked_capabilities,
    expiresAt: row.expires_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateBridgeRequestInput {
  workspaceId: string;
  operationRunId?: string | null;
  title: string;
  taskPrompt: string;
  assistantType: BridgeAssistantType;
  requestType: BridgeRequestType;
  riskLevel: BridgeRiskLevel;
  approvalMode: BridgeApprovalMode;
  expectedResultSchema?: Record<string, unknown>;
  allowedCapabilities?: string[];
  blockedCapabilities?: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export async function createBridgeRequest(
  input: CreateBridgeRequestInput,
): Promise<OperatorBridgeRequest> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + BRIDGE_NONCE_TTL_MS).toISOString();

  const insert: OperatorBridgeRequestInsert = {
    workspace_id: input.workspaceId,
    operation_run_id: input.operationRunId ?? null,
    requested_by: user.id,
    assistant_type: input.assistantType,
    request_type: input.requestType,
    risk_level: input.riskLevel,
    approval_mode: input.approvalMode,
    status: "pending_operator",
    title: input.title,
    task_prompt: input.taskPrompt,
    expected_result_schema: input.expectedResultSchema ?? {},
    allowed_capabilities: input.allowedCapabilities ?? [],
    blocked_capabilities: input.blockedCapabilities ?? [],
    expires_at: expiresAt,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("operator_bridge_requests")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to create operator bridge request.");
  return toRequest(data as unknown as OperatorBridgeRequestRow);
}

export async function getBridgeRequestById(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("operator_bridge_requests")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.requestId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load bridge request.");
  if (!data) throw notFound("Operator bridge request");
  return toRequest(data as unknown as OperatorBridgeRequestRow);
}

export async function listBridgeRequests(input: {
  workspaceId: string;
  limit?: number;
}): Promise<OperatorBridgeRequest[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("operator_bridge_requests")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 50);
  if (error) throw fromPostgres(error, "Failed to list bridge requests.");
  return ((data ?? []) as unknown as OperatorBridgeRequestRow[]).map(toRequest);
}

async function applyStatus(
  workspaceId: string,
  requestId: string,
  next: BridgeRequestStatus,
  patch: OperatorBridgeRequestUpdate = {},
): Promise<OperatorBridgeRequest> {
  const current = await getBridgeRequestById({ workspaceId, requestId });
  assertTransition(current.status, next);
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("operator_bridge_requests")
    .update({ ...patch, status: next } as never)
    .eq("workspace_id", workspaceId)
    .eq("id", requestId);
  if (error) throw fromPostgres(error, "Failed to update bridge request.");
  return getBridgeRequestById({ workspaceId, requestId });
}

export async function markRequestCopied(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "copied");
}

export async function markRequestRunning(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "running");
}

export async function markRequestResultSubmitted(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "result_submitted");
}

export async function markRequestVerified(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "verified");
}

export async function markRequestFailedVerification(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(
    input.workspaceId,
    input.requestId,
    "failed_verification",
  );
}

export async function markRequestRejected(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "rejected");
}

export async function markRequestCompleted(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "completed");
}

export async function cancelRequest(input: {
  workspaceId: string;
  requestId: string;
  reason?: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "cancelled", {
    metadata: input.reason ? { cancel_reason: input.reason } : undefined,
  });
}

export async function expireRequest(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeRequest> {
  return applyStatus(input.workspaceId, input.requestId, "expired");
}
