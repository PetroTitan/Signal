import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  DraftVariantInsert,
  DraftVariantRow,
  DraftVariantStatus,
  DraftVariantUpdate,
  RiskLevel,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface DraftVariant {
  id: string;
  workspaceId: string;
  productId: string | null;
  weeklyPlanItemId: string | null;
  platform: string | null;
  variantType: string | null;
  title: string | null;
  body: string;
  status: DraftVariantStatus;
  riskLevel: RiskLevel | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toDraft(row: DraftVariantRow): DraftVariant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    weeklyPlanItemId: row.weekly_plan_item_id,
    platform: row.platform,
    variantType: row.variant_type,
    title: row.title,
    body: row.body,
    status: row.status,
    riskLevel: row.risk_level,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listDraftVariants(
  workspaceId: string,
  options: { itemId?: string | null; productId?: string | null } = {},
): Promise<DraftVariant[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("draft_variants")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (options.itemId) query = query.eq("weekly_plan_item_id", options.itemId);
  if (options.productId) query = query.eq("product_id", options.productId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw fromPostgres(error, "Failed to list draft variants.");
  return ((data ?? []) as unknown as DraftVariantRow[]).map(toDraft);
}

export interface DraftVariantInput {
  workspaceId: string;
  productId?: string | null;
  weeklyPlanItemId?: string | null;
  platform?: string | null;
  variantType?: string | null;
  title?: string | null;
  body: string;
  riskLevel?: RiskLevel | null;
  metadata?: Record<string, unknown>;
}

export async function createDraftVariant(
  input: DraftVariantInput,
): Promise<DraftVariant> {
  const supabase = createSupabaseServerClient();
  const insert: DraftVariantInsert = {
    workspace_id: input.workspaceId,
    product_id: input.productId ?? null,
    weekly_plan_item_id: input.weeklyPlanItemId ?? null,
    platform: input.platform ?? null,
    variant_type: input.variantType ?? null,
    title: input.title ?? null,
    body: input.body,
    risk_level: input.riskLevel ?? null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("draft_variants")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to save draft variant.");
  return toDraft(data as unknown as DraftVariantRow);
}

export async function updateDraftVariant(input: {
  workspaceId: string;
  draftId: string;
  patch: DraftVariantUpdate;
}): Promise<DraftVariant> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("draft_variants")
    .update(input.patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.draftId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update draft variant.");
  return toDraft(data as unknown as DraftVariantRow);
}
