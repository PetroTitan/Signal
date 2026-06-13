import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WeeklyPlanInsert,
  WeeklyPlanItemInsert,
  WeeklyPlanItemRow,
  WeeklyPlanItemStatus,
  WeeklyPlanItemUpdate,
  WeeklyPlanRow,
  WeeklyPlanStatus,
  WeeklyPlanUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

export interface WeeklyPlan {
  id: string;
  workspaceId: string;
  title: string;
  weekStart: string;
  status: WeeklyPlanStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyPlanItem {
  id: string;
  workspaceId: string;
  weeklyPlanId: string;
  productId: string | null;
  accountId: string | null;
  platform: string | null;
  contentType: string | null;
  title: string | null;
  body: string | null;
  cta: string | null;
  linkUrl: string | null;
  status: WeeklyPlanItemStatus;
  riskLevel: WeeklyPlanItemRow["risk_level"];
  riskScore: number | null;
  scheduledAt: string | null;
  metadata: Record<string, unknown>;
  /**
   * Phase F6.0 — opaque JSONB envelope for the operator's
   * platform-native shape. Consumers should parse via
   * parsePlatformNativeShape from @/core/platform-native rather than
   * touching keys directly here. Null on legacy rows.
   */
  platformPublishIntent: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

function toPlan(row: WeeklyPlanRow): WeeklyPlan {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    weekStart: row.week_start,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: WeeklyPlanItemRow): WeeklyPlanItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    weeklyPlanId: row.weekly_plan_id,
    productId: row.product_id,
    accountId: row.account_id,
    platform: row.platform,
    contentType: row.content_type,
    title: row.title,
    body: row.body,
    cta: row.cta,
    linkUrl: row.link_url,
    status: row.status,
    riskLevel: row.risk_level,
    riskScore: row.risk_score,
    scheduledAt: row.scheduled_at,
    metadata: row.metadata,
    platformPublishIntent: row.platform_publish_intent ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWeeklyPlans(
  workspaceId: string,
  limit = 12,
): Promise<WeeklyPlan[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plans")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("week_start", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list weekly plans.");
  return ((data ?? []) as unknown as WeeklyPlanRow[]).map(toPlan);
}

export async function getCurrentWeeklyPlan(
  workspaceId: string,
): Promise<WeeklyPlan | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plans")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load current weekly plan.");
  return data ? toPlan(data as unknown as WeeklyPlanRow) : null;
}

export async function getWeeklyPlanById(
  workspaceId: string,
  planId: string,
): Promise<WeeklyPlan> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plans")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", planId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load weekly plan.");
  if (!data) throw notFound("Weekly plan");
  return toPlan(data as unknown as WeeklyPlanRow);
}

export interface WeeklyPlanInput {
  workspaceId: string;
  title: string;
  weekStart: string;
}

export async function createWeeklyPlan(
  input: WeeklyPlanInput,
): Promise<WeeklyPlan> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const insert: WeeklyPlanInsert = {
    workspace_id: input.workspaceId,
    title: input.title,
    week_start: input.weekStart,
    created_by: user.id,
  };
  const { data, error } = await supabase
    .from("weekly_plans")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create weekly plan.");
  return toPlan(data as unknown as WeeklyPlanRow);
}

export async function updateWeeklyPlanStatus(input: {
  workspaceId: string;
  planId: string;
  status: WeeklyPlanStatus;
}): Promise<WeeklyPlan> {
  const supabase = createSupabaseServerClient();
  const patch: WeeklyPlanUpdate = { status: input.status };
  const { data, error } = await supabase
    .from("weekly_plans")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.planId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update plan status.");
  return toPlan(data as unknown as WeeklyPlanRow);
}

// =====================================================================
// Items
// =====================================================================

export async function listPlanItems(
  workspaceId: string,
  planId: string,
): Promise<WeeklyPlanItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("weekly_plan_id", planId)
    .order("scheduled_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list plan items.");
  return ((data ?? []) as unknown as WeeklyPlanItemRow[]).map(toItem);
}

export async function listPlanItemsByStatus(
  workspaceId: string,
  statuses: WeeklyPlanItemStatus[],
): Promise<WeeklyPlanItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", statuses)
    .order("scheduled_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list plan items.");
  return ((data ?? []) as unknown as WeeklyPlanItemRow[]).map(toItem);
}

/**
 * A6 — unfinished items that live in OLDER weekly plans (not the
 * current one). The dashboard/weekly-plan focus on the newest plan, so
 * once the week rolls over, in-flight items from prior plans vanish
 * from the workflow. This surfaces them.
 *
 * "Unfinished" = the plan-item statuses that still represent work in
 * flight: draft, pending_approval, approved (hold), scheduled, paused
 * (the plan-item mirror parks failed/blocked execution items here).
 * Terminal statuses (published, rejected, backlog, skipped) are
 * excluded — they are NOT carry-over candidates. Read-only; never
 * mutates rows.
 */
const UNFINISHED_PLAN_ITEM_STATUSES: WeeklyPlanItemStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "paused",
];

export async function listUnfinishedItemsFromOlderPlans(
  workspaceId: string,
  currentPlanId: string | null,
  limit = 50,
): Promise<WeeklyPlanItem[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("weekly_plan_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", UNFINISHED_PLAN_ITEM_STATUSES);
  // Exclude the current plan so this is strictly "from previous weeks".
  if (currentPlanId) query = query.neq("weekly_plan_id", currentPlanId);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error)
    throw fromPostgres(error, "Failed to list unfinished older-plan items.");
  return ((data ?? []) as unknown as WeeklyPlanItemRow[]).map(toItem);
}

export async function getPlanItemById(
  workspaceId: string,
  itemId: string,
): Promise<WeeklyPlanItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load plan item.");
  if (!data) throw notFound("Plan item");
  return toItem(data as unknown as WeeklyPlanItemRow);
}

export interface PlanItemInput {
  workspaceId: string;
  weeklyPlanId: string;
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  linkUrl?: string | null;
  productId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  contentType?: string | null;
  status?: WeeklyPlanItemStatus;
  riskLevel?: WeeklyPlanItemRow["risk_level"];
  riskScore?: number | null;
  scheduledAt?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Phase F6.0 — opaque JSONB envelope describing the operator's
   * platform-native shape. Repository writes are passthrough only;
   * structural validation belongs to the adapter layer.
   */
  platformPublishIntent?: Record<string, unknown> | null;
}

export async function createPlanItem(input: PlanItemInput): Promise<WeeklyPlanItem> {
  const supabase = createSupabaseServerClient();
  const insert: WeeklyPlanItemInsert = {
    workspace_id: input.workspaceId,
    weekly_plan_id: input.weeklyPlanId,
    title: input.title ?? null,
    body: input.body ?? null,
    cta: input.cta ?? null,
    link_url: input.linkUrl ?? null,
    product_id: input.productId ?? null,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    content_type: input.contentType ?? null,
    status: input.status ?? "draft",
    risk_level: input.riskLevel ?? null,
    risk_score: input.riskScore ?? null,
    scheduled_at: input.scheduledAt ?? null,
    metadata: input.metadata ?? {},
    platform_publish_intent: input.platformPublishIntent ?? null,
  };
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create plan item.");
  return toItem(data as unknown as WeeklyPlanItemRow);
}

export async function updatePlanItem(input: {
  workspaceId: string;
  itemId: string;
  patch: WeeklyPlanItemUpdate;
}): Promise<WeeklyPlanItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .update(input.patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.itemId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update plan item.");
  return toItem(data as unknown as WeeklyPlanItemRow);
}

export async function updatePlanItemStatus(input: {
  workspaceId: string;
  itemId: string;
  status: WeeklyPlanItemStatus;
}): Promise<WeeklyPlanItem> {
  return updatePlanItem({
    workspaceId: input.workspaceId,
    itemId: input.itemId,
    patch: { status: input.status },
  });
}

/**
 * A6 — relocate a plan item into a different (current) weekly plan.
 *
 * Writes ONLY `weekly_plan_id` (an existing column). Status, schedule,
 * approval, creatives, and any linked execution_item (which references
 * the plan_item id, not the plan) are untouched — so carry-over never
 * creates/duplicates an execution item and never changes approval
 * state. A separate, narrow function (not the general `updatePlanItem`
 * patch) so this stays auditable and the shared update shape is
 * unchanged.
 */
export async function movePlanItemToPlan(input: {
  workspaceId: string;
  itemId: string;
  weeklyPlanId: string;
}): Promise<WeeklyPlanItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_items")
    .update({ weekly_plan_id: input.weeklyPlanId } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.itemId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to move plan item.");
  return toItem(data as unknown as WeeklyPlanItemRow);
}

/**
 * Hard-delete a plan item. Used by removePlanItemAction when the
 * item has not yet been published. Creatives + plan-item join rows
 * cascade via FK; execution_items must be cancelled BEFORE this is
 * called (they reference plan items through metadata.plan_item_id /
 * source_entity_id, not through a FK).
 *
 * publish_history rows are NEVER removed — they keep `execution_item_id`
 * if there was one, and that row stays around since execution_items
 * don't reference plan_items by FK.
 */
export async function deletePlanItem(input: {
  workspaceId: string;
  itemId: string;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("weekly_plan_items")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.itemId);
  if (error) throw fromPostgres(error, "Failed to delete plan item.");
}
