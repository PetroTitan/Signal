import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  BacklogItemInsert,
  BacklogItemRow,
  BacklogItemStatus,
  BacklogItemUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notFound } from "./errors";

export interface BacklogItem {
  id: string;
  workspaceId: string;
  sourceItemId: string | null;
  productId: string | null;
  accountId: string | null;
  platform: string | null;
  title: string | null;
  body: string | null;
  reason: string | null;
  status: BacklogItemStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toBacklog(row: BacklogItemRow): BacklogItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceItemId: row.source_item_id,
    productId: row.product_id,
    accountId: row.account_id,
    platform: row.platform,
    title: row.title,
    body: row.body,
    reason: row.reason,
    status: row.status,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBacklog(
  workspaceId: string,
  status: BacklogItemStatus = "backlog",
): Promise<BacklogItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("backlog_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", status)
    .order("created_at", { ascending: false });
  if (error) throw fromPostgres(error, "Failed to list backlog.");
  return ((data ?? []) as unknown as BacklogItemRow[]).map(toBacklog);
}

export async function getBacklogItemById(
  workspaceId: string,
  backlogId: string,
): Promise<BacklogItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("backlog_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", backlogId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load backlog item.");
  if (!data) throw notFound("Backlog item");
  return toBacklog(data as unknown as BacklogItemRow);
}

export interface BacklogItemInput {
  workspaceId: string;
  sourceItemId?: string | null;
  productId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  title?: string | null;
  body?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createBacklogItem(
  input: BacklogItemInput,
): Promise<BacklogItem> {
  const supabase = createSupabaseServerClient();
  const insert: BacklogItemInsert = {
    workspace_id: input.workspaceId,
    source_item_id: input.sourceItemId ?? null,
    product_id: input.productId ?? null,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("backlog_items")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create backlog item.");
  return toBacklog(data as unknown as BacklogItemRow);
}

export async function updateBacklogStatus(input: {
  workspaceId: string;
  backlogId: string;
  status: BacklogItemStatus;
  reason?: string | null;
}): Promise<BacklogItem> {
  const supabase = createSupabaseServerClient();
  const patch: BacklogItemUpdate = { status: input.status };
  if (input.reason !== undefined) patch.reason = input.reason;
  const { data, error } = await supabase
    .from("backlog_items")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.backlogId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update backlog item.");
  return toBacklog(data as unknown as BacklogItemRow);
}
