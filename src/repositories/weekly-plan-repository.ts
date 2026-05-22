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
