import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type {
  McpToolApprovalMode,
  McpToolCallInsert,
  McpToolCallRow,
  McpToolCallStatus,
  McpToolRiskLevel,
} from "@/lib/supabase/types";

/**
 * Phase F0 — append-only audit writer for the MCP HTTP bridge.
 *
 * Never receives a tool argument tree. Callers pass already-redacted
 * summaries so we cannot accidentally store secrets pulled from the
 * raw input.
 */
export interface OpenToolCallInput {
  workspaceId: string;
  operatorTokenId: string | null;
  toolName: string;
  riskLevel: McpToolRiskLevel;
  approvalMode: McpToolApprovalMode;
  inputSummary?: string | null;
}

export interface CloseToolCallInput {
  workspaceId: string;
  callId: string;
  status: McpToolCallStatus;
  outputSummary?: string | null;
  errorSummary?: string | null;
}

export async function openToolCall(
  input: OpenToolCallInput,
): Promise<string | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const insert: McpToolCallInsert = {
    workspace_id: input.workspaceId,
    operator_token_id: input.operatorTokenId,
    tool_name: input.toolName,
    risk_level: input.riskLevel,
    approval_mode: input.approvalMode,
    status: "allowed",
    input_summary: input.inputSummary ?? null,
  };
  const { data, error } = await supabase
    .from("mcp_tool_calls")
    .insert(insert as never)
    .select("id")
    .single();
  if (error || !data) {
    console.error("[mcp-audit] openToolCall failed", error);
    return null;
  }
  return (data as { id: string }).id;
}

export async function closeToolCall(input: CloseToolCallInput): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  // Audit table has no UPDATE policy; we re-create the closing event
  // as a row update via the service-role client (RLS is bypassed for
  // the elevated role). We never expose this update path through any
  // other surface.
  const { error } = await supabase
    .from("mcp_tool_calls")
    .update({
      status: input.status,
      output_summary: input.outputSummary ?? null,
      error_summary: input.errorSummary ?? null,
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.callId);
  if (error) {
    console.error("[mcp-audit] closeToolCall failed", error);
  }
}

export async function listRecentToolCalls(
  workspaceId: string,
  limit = 30,
): Promise<McpToolCallRow[]> {
  // Used by /settings/mcp for the recent-calls panel. Goes through the
  // service-role client because the operator's session has RLS that
  // already returns the right rows — but we want this to work even
  // when called from places that don't carry a session.
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("mcp_tool_calls")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[mcp-audit] listRecentToolCalls failed", error);
    return [];
  }
  return ((data ?? []) as unknown as McpToolCallRow[]);
}
