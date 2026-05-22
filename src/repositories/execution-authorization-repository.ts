import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionAuthorizationInsert,
  ExecutionAuthorizationRow,
} from "@/lib/supabase/types";
import type {
  AuthorizationResult,
  ExecutionAuthorizationContext,
} from "@/core/weekly-contract";
import {
  aggregateSnapshot,
  type ActionCountSnapshot,
} from "@/core/weekly-contract";
import { toLocalDayKey } from "@/core/weekly-contract";
import { fromPostgres } from "./errors";

export interface ExecutionAuthorizationLogEntry {
  id: string;
  workspaceId: string;
  contractId: string | null;
  actionType: string;
  accountId: string | null;
  productId: string | null;
  platform: string | null;
  scheduledItemId: string | null;
  weeklyPlanItemId: string | null;
  outcome: ExecutionAuthorizationRow["outcome"];
  reasonCode: ExecutionAuthorizationRow["reason_code"];
  reasonDetail: string | null;
  suggestedAction: ExecutionAuthorizationRow["suggested_action"];
  shouldBacklog: boolean;
  shouldPause: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toEntry(row: ExecutionAuthorizationRow): ExecutionAuthorizationLogEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contractId: row.contract_id,
    actionType: row.action_type,
    accountId: row.account_id,
    productId: row.product_id,
    platform: row.platform,
    scheduledItemId: row.scheduled_item_id,
    weeklyPlanItemId: row.weekly_plan_item_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    suggestedAction: row.suggested_action,
    shouldBacklog: row.should_backlog,
    shouldPause: row.should_pause,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function recordExecutionAuthorization(input: {
  context: ExecutionAuthorizationContext;
  result: AuthorizationResult;
}): Promise<ExecutionAuthorizationLogEntry> {
  const supabase = createSupabaseServerClient();
  const insert: ExecutionAuthorizationInsert = {
    workspace_id: input.context.workspaceId,
    contract_id: input.context.contractId,
    action_type: input.context.actionType,
    account_id: input.context.accountId,
    product_id: input.context.productId,
    platform: input.context.platform,
    scheduled_item_id: input.context.scheduledItemId,
    weekly_plan_item_id: input.context.weeklyPlanItemId,
    outcome: input.result.outcome,
    reason_code: input.result.reasonCode,
    reason_detail: input.result.reasonDetail,
    suggested_action: input.result.suggestedAction,
    should_backlog: input.result.shouldBacklog,
    should_pause: input.result.shouldPause,
    metadata: input.context.extraMetadata ?? {},
  };
  const { data, error } = await supabase
    .from("execution_authorizations")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to record execution authorization.");
  return toEntry(data as unknown as ExecutionAuthorizationRow);
}

export async function listExecutionAuthorizations(
  workspaceId: string,
  limit = 50,
): Promise<ExecutionAuthorizationLogEntry[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_authorizations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error)
    throw fromPostgres(error, "Failed to list execution authorizations.");
  return ((data ?? []) as unknown as ExecutionAuthorizationRow[]).map(toEntry);
}

export async function listExecutionAuthorizationsForContract(
  workspaceId: string,
  contractId: string,
  limit = 100,
): Promise<ExecutionAuthorizationLogEntry[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_authorizations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error)
    throw fromPostgres(error, "Failed to list execution authorizations.");
  return ((data ?? []) as unknown as ExecutionAuthorizationRow[]).map(toEntry);
}

/**
 * Pull the cadence snapshot for an active contract by aggregating the
 * `allowed` authorizations that belong to it. Used by the engine
 * before evaluation.
 */
export async function loadCadenceSnapshotForContract(input: {
  workspaceId: string;
  contractId: string;
  weekStartIso: string;
  weekEndIso: string;
  timezone: string | null;
}): Promise<ActionCountSnapshot> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_authorizations")
    .select("outcome, platform, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("contract_id", input.contractId)
    .gte("created_at", input.weekStartIso)
    .lte("created_at", input.weekEndIso);
  if (error) throw fromPostgres(error, "Failed to load cadence snapshot.");
  const rows = (data ?? []) as Array<{
    outcome: string;
    platform: string | null;
    created_at: string;
  }>;
  return aggregateSnapshot(rows, (iso) => toLocalDayKey(iso, input.timezone));
}
