import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  McpConnectorProbeInsert,
  McpConnectorProbeRow,
  McpConnectorProbeUpdate,
  McpProbeMode,
  McpProbeStatus,
} from "@/lib/supabase/types";
import type { SupabaseProbeResult } from "@/core/mcp-runtime/supabase-probe";
import { fromPostgres, notAuthenticated, notFound } from "../errors";

export interface McpConnectorProbe {
  id: string;
  workspaceId: string;
  connectorType: McpConnectorProbeRow["connector_type"];
  mode: McpProbeMode;
  status: McpProbeStatus;
  requestedBy: string | null;
  completedBy: string | null;
  capabilityResults: Record<string, unknown>;
  healthStatus: McpConnectorProbeRow["health_status"];
  errorSummary: string | null;
  evidence: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

function toProbe(row: McpConnectorProbeRow): McpConnectorProbe {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectorType: row.connector_type,
    mode: row.mode,
    status: row.status,
    requestedBy: row.requested_by,
    completedBy: row.completed_by,
    capabilityResults: row.capability_results,
    healthStatus: row.health_status,
    errorSummary: row.error_summary,
    evidence: row.evidence,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function openProbe(input: {
  workspaceId: string;
  connectorType: McpConnectorProbeRow["connector_type"];
  mode: McpProbeMode;
}): Promise<McpConnectorProbe> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();
  const insert: McpConnectorProbeInsert = {
    workspace_id: input.workspaceId,
    connector_type: input.connectorType,
    mode: input.mode,
    status: "running",
    requested_by: user.id,
  };
  const { data, error } = await supabase
    .from("mcp_connector_probes")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to open MCP connector probe.");
  return toProbe(data as unknown as McpConnectorProbeRow);
}

export async function completeProbe(input: {
  workspaceId: string;
  probeId: string;
  result: SupabaseProbeResult;
}): Promise<McpConnectorProbe> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const patch: McpConnectorProbeUpdate = {
    status: "completed",
    completed_by: user?.id ?? null,
    completed_at: new Date().toISOString(),
    capability_results: input.result.capabilities,
    health_status:
      input.result.status === "healthy"
        ? "healthy"
        : input.result.status === "degraded"
        ? "degraded"
        : "failed",
    evidence: input.result.evidence as unknown as Record<string, unknown>,
    error_summary: null,
  };
  const { data, error } = await supabase
    .from("mcp_connector_probes")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.probeId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to complete MCP connector probe.");
  return toProbe(data as unknown as McpConnectorProbeRow);
}

export async function failProbe(input: {
  workspaceId: string;
  probeId: string;
  errorSummary: string;
  evidence?: Record<string, unknown>;
}): Promise<McpConnectorProbe> {
  const supabase = createSupabaseServerClient();
  const patch: McpConnectorProbeUpdate = {
    status: "failed",
    completed_at: new Date().toISOString(),
    health_status: "failed",
    error_summary: input.errorSummary,
    evidence: input.evidence,
  };
  const { data, error } = await supabase
    .from("mcp_connector_probes")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.probeId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to mark MCP connector probe as failed.");
  return toProbe(data as unknown as McpConnectorProbeRow);
}

export async function getLatestProbe(input: {
  workspaceId: string;
  connectorType: McpConnectorProbeRow["connector_type"];
}): Promise<McpConnectorProbe | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_connector_probes")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("connector_type", input.connectorType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load MCP connector probe.");
  if (!data) return null;
  return toProbe(data as unknown as McpConnectorProbeRow);
}

export async function getProbeById(input: {
  workspaceId: string;
  probeId: string;
}): Promise<McpConnectorProbe> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_connector_probes")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.probeId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load MCP connector probe.");
  if (!data) throw notFound("MCP connector probe");
  return toProbe(data as unknown as McpConnectorProbeRow);
}

export async function listRecentProbes(input: {
  workspaceId: string;
  connectorType?: McpConnectorProbeRow["connector_type"];
  limit?: number;
}): Promise<McpConnectorProbe[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("mcp_connector_probes")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 20);
  if (input.connectorType) {
    query = query.eq("connector_type", input.connectorType);
  }
  const { data, error } = await query;
  if (error) throw fromPostgres(error, "Failed to list MCP connector probes.");
  return ((data ?? []) as unknown as McpConnectorProbeRow[]).map(toProbe);
}
