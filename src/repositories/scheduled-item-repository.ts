import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ScheduledItemInsert,
  ScheduledItemRow,
  ScheduledItemStatus,
  ScheduledItemUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notFound } from "./errors";

export interface ScheduledItem {
  id: string;
  workspaceId: string;
  weeklyPlanItemId: string | null;
  productId: string | null;
  accountId: string | null;
  platform: string | null;
  scheduledAt: string;
  status: ScheduledItemStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toScheduled(row: ScheduledItemRow): ScheduledItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    weeklyPlanItemId: row.weekly_plan_item_id,
    productId: row.product_id,
    accountId: row.account_id,
    platform: row.platform,
    scheduledAt: row.scheduled_at,
    status: row.status,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listScheduledItems(
  workspaceId: string,
  statuses: ScheduledItemStatus[] = ["scheduled", "paused"],
): Promise<ScheduledItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("scheduled_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", statuses)
    .order("scheduled_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list scheduled items.");
  return ((data ?? []) as unknown as ScheduledItemRow[]).map(toScheduled);
}

export interface ScheduledItemInput {
  workspaceId: string;
  weeklyPlanItemId?: string | null;
  productId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  scheduledAt: string;
  metadata?: Record<string, unknown>;
}

export async function scheduleItem(
  input: ScheduledItemInput,
): Promise<ScheduledItem> {
  const supabase = createSupabaseServerClient();
  const insert: ScheduledItemInsert = {
    workspace_id: input.workspaceId,
    weekly_plan_item_id: input.weeklyPlanItemId ?? null,
    product_id: input.productId ?? null,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    scheduled_at: input.scheduledAt,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("scheduled_items")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to schedule item.");
  return toScheduled(data as unknown as ScheduledItemRow);
}

export async function updateScheduledItem(input: {
  workspaceId: string;
  scheduledItemId: string;
  patch: ScheduledItemUpdate;
}): Promise<ScheduledItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("scheduled_items")
    .update(input.patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.scheduledItemId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update scheduled item.");
  return toScheduled(data as unknown as ScheduledItemRow);
}

export async function getScheduledItemById(
  workspaceId: string,
  scheduledItemId: string,
): Promise<ScheduledItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("scheduled_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", scheduledItemId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load scheduled item.");
  if (!data) throw notFound("Scheduled item");
  return toScheduled(data as unknown as ScheduledItemRow);
}
