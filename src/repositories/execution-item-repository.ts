import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionItemInsert,
  ExecutionItemRow,
  ExecutionItemUpdate,
} from "@/lib/supabase/types";
import type {
  ExecutionItem,
  ExecutionItemRiskLevel,
  ExecutionItemStatus,
} from "@/core/execution-engine";
import { transitionItem } from "@/core/execution-engine";
import { fromPostgres, notFound } from "./errors";

function toItem(row: ExecutionItemRow): ExecutionItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    queueId: row.queue_id,
    contractId: row.contract_id,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    productId: row.product_id,
    accountId: row.account_id,
    platform: row.platform,
    actionType: row.action_type,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    scheduledAt: row.scheduled_at,
    status: row.status,
    riskScore: row.risk_score,
    riskLevel: row.risk_level,
    authorizationId: row.authorization_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateExecutionItemInput {
  workspaceId: string;
  queueId: string;
  contractId: string;
  actionType: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  productId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  title?: string | null;
  body?: string | null;
  linkUrl?: string | null;
  scheduledAt?: string | null;
  riskScore?: number | null;
  riskLevel?: ExecutionItemRiskLevel | null;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export async function createExecutionItem(
  input: CreateExecutionItemInput,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  const insert: ExecutionItemInsert = {
    workspace_id: input.workspaceId,
    queue_id: input.queueId,
    contract_id: input.contractId,
    source_entity_type: input.sourceEntityType ?? null,
    source_entity_id: input.sourceEntityId ?? null,
    product_id: input.productId ?? null,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    action_type: input.actionType,
    title: input.title ?? null,
    body: input.body ?? null,
    link_url: input.linkUrl ?? null,
    scheduled_at: input.scheduledAt ?? null,
    status: "pending_authorization",
    risk_score: input.riskScore ?? null,
    risk_level: input.riskLevel ?? null,
    max_attempts: input.maxAttempts ?? 3,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("execution_items")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create execution item.");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function getExecutionItemById(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load execution item.");
  if (!data) throw notFound("Execution item");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function listItemsForQueue(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("queue_id", queueId)
    .order("scheduled_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list execution items.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

async function applyItemUpdate(
  workspaceId: string,
  itemId: string,
  patch: ExecutionItemUpdate,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .update(patch as never)
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update execution item.");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function updateItemStatus(input: {
  workspaceId: string;
  itemId: string;
  to: ExecutionItemStatus;
  patch?: ExecutionItemUpdate;
}): Promise<ExecutionItem> {
  const current = await getExecutionItemById(input.workspaceId, input.itemId);
  const verdict = transitionItem(current.status, input.to);
  if (!verdict.ok) throw verdict.error;
  return applyItemUpdate(input.workspaceId, input.itemId, {
    ...(input.patch ?? {}),
    status: input.to,
  });
}

export async function attachAuthorization(input: {
  workspaceId: string;
  itemId: string;
  authorizationId: string;
}): Promise<ExecutionItem> {
  return applyItemUpdate(input.workspaceId, input.itemId, {
    authorization_id: input.authorizationId,
  });
}

export async function incrementAttemptCount(input: {
  workspaceId: string;
  itemId: string;
}): Promise<ExecutionItem> {
  const current = await getExecutionItemById(input.workspaceId, input.itemId);
  return applyItemUpdate(input.workspaceId, input.itemId, {
    attempt_count: current.attemptCount + 1,
  });
}

export async function moveItemToBacklog(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "backlogged" });
}

export async function markItemSkipped(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "skipped" });
}

export async function markItemBlocked(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "blocked" });
}

export async function markItemCompleted(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "completed" });
}
