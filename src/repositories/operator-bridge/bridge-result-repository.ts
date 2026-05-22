import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  OperatorBridgeResultInsert,
  OperatorBridgeResultRow,
  OperatorBridgeResultUpdate,
} from "@/lib/supabase/types";
import type {
  BridgeAssistantType,
  BridgeResultStatus,
  BridgeVerificationStatus,
  OperatorBridgeResult,
} from "@/core/operator-bridge";
import { fromPostgres } from "../errors";

function toResult(row: OperatorBridgeResultRow): OperatorBridgeResult {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    submittedBy: row.submitted_by,
    assistantType: row.assistant_type,
    status: row.status,
    resultSummary: row.result_summary,
    resultPayload: row.result_payload,
    verificationStatus: row.verification_status,
    verificationErrors: row.verification_errors,
    signature: row.signature,
    signedAt: row.signed_at,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export interface InsertBridgeResultInput {
  workspaceId: string;
  requestId: string;
  assistantType: BridgeAssistantType;
  status?: BridgeResultStatus;
  resultSummary: string;
  resultPayload: Record<string, unknown>;
  verificationStatus?: BridgeVerificationStatus;
  verificationErrors?: string[];
  signature?: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertBridgeResult(
  input: InsertBridgeResultInput,
): Promise<OperatorBridgeResult> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const insert: OperatorBridgeResultInsert = {
    workspace_id: input.workspaceId,
    request_id: input.requestId,
    submitted_by: user?.id ?? null,
    assistant_type: input.assistantType,
    status: input.status ?? "submitted",
    result_summary: input.resultSummary,
    result_payload: input.resultPayload,
    verification_status: input.verificationStatus ?? "pending",
    verification_errors: input.verificationErrors ?? [],
    signature: input.signature ?? null,
    signed_at: input.signature ? new Date().toISOString() : null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("operator_bridge_results")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to record bridge result.");
  return toResult(data as unknown as OperatorBridgeResultRow);
}

export async function updateResultVerification(input: {
  workspaceId: string;
  resultId: string;
  status: BridgeResultStatus;
  verificationStatus: BridgeVerificationStatus;
  verificationErrors?: string[];
}): Promise<OperatorBridgeResult> {
  const supabase = createSupabaseServerClient();
  const patch: OperatorBridgeResultUpdate = {
    status: input.status,
    verification_status: input.verificationStatus,
    verification_errors: input.verificationErrors ?? [],
  };
  const { data, error } = await supabase
    .from("operator_bridge_results")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.resultId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to update bridge result.");
  return toResult(data as unknown as OperatorBridgeResultRow);
}

export async function listResultsForRequest(input: {
  workspaceId: string;
  requestId: string;
  limit?: number;
}): Promise<OperatorBridgeResult[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("operator_bridge_results")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("request_id", input.requestId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 20);
  if (error)
    throw fromPostgres(error, "Failed to list bridge results.");
  return ((data ?? []) as unknown as OperatorBridgeResultRow[]).map(toResult);
}
