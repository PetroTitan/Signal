import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  RiskEventInsert,
  RiskEventRow,
  RiskLevel,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface RiskEvent {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string | null;
  riskLevel: RiskLevel;
  riskScore: number | null;
  reason: string;
  recommendation: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toRiskEvent(row: RiskEventRow): RiskEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    riskLevel: row.risk_level,
    riskScore: row.risk_score,
    reason: row.reason,
    recommendation: row.recommendation,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function listRiskEvents(
  workspaceId: string,
  limit = 50,
): Promise<RiskEvent[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("risk_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list risk events.");
  return ((data ?? []) as unknown as RiskEventRow[]).map(toRiskEvent);
}

export interface RiskEventInput {
  workspaceId: string;
  entityType: string;
  entityId?: string | null;
  riskLevel: RiskLevel;
  riskScore?: number | null;
  reason: string;
  recommendation?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordRiskEvent(input: RiskEventInput): Promise<RiskEvent> {
  const supabase = createSupabaseServerClient();
  const insert: RiskEventInsert = {
    workspace_id: input.workspaceId,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    risk_level: input.riskLevel,
    risk_score: input.riskScore ?? null,
    reason: input.reason,
    recommendation: input.recommendation ?? null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("risk_events")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to record risk event.");
  return toRiskEvent(data as unknown as RiskEventRow);
}
