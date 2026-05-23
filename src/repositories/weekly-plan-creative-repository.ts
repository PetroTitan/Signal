import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  CreativeSourceType,
  CreativeStatus,
  CreativeType,
  WeeklyPlanItemCreativeInsert,
  WeeklyPlanItemCreativeRow,
  WeeklyPlanItemCreativeUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notFound } from "./errors";

export interface WeeklyPlanItemCreative {
  id: string;
  workspaceId: string;
  weeklyPlanItemId: string;
  creativeType: CreativeType;
  sourceType: CreativeSourceType;
  sourceUrl: string | null;
  assetUrl: string | null;
  prompt: string | null;
  altText: string | null;
  license: string | null;
  attribution: string | null;
  riskNotes: string | null;
  status: CreativeStatus;
  storagePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  uploadedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toCreative(row: WeeklyPlanItemCreativeRow): WeeklyPlanItemCreative {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    weeklyPlanItemId: row.weekly_plan_item_id,
    creativeType: row.creative_type,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    assetUrl: row.asset_url,
    prompt: row.prompt,
    altText: row.alt_text,
    license: row.license,
    attribution: row.attribution,
    riskNotes: row.risk_notes,
    status: row.status,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateCreativeInput {
  workspaceId: string;
  weeklyPlanItemId: string;
  creativeType: CreativeType;
  sourceType: CreativeSourceType;
  sourceUrl?: string | null;
  assetUrl?: string | null;
  prompt?: string | null;
  altText?: string | null;
  license?: string | null;
  attribution?: string | null;
  riskNotes?: string | null;
  status?: CreativeStatus;
  metadata?: Record<string, unknown>;
}

export async function createCreative(
  input: CreateCreativeInput,
): Promise<WeeklyPlanItemCreative> {
  const supabase = createSupabaseServerClient();
  const insert: WeeklyPlanItemCreativeInsert = {
    workspace_id: input.workspaceId,
    weekly_plan_item_id: input.weeklyPlanItemId,
    creative_type: input.creativeType,
    source_type: input.sourceType,
    source_url: input.sourceUrl ?? null,
    asset_url: input.assetUrl ?? null,
    prompt: input.prompt ?? null,
    alt_text: input.altText ?? null,
    license: input.license ?? null,
    attribution: input.attribution ?? null,
    risk_notes: input.riskNotes ?? null,
    status: input.status ?? "planned",
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("weekly_plan_item_creatives")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create creative.");
  return toCreative(data as unknown as WeeklyPlanItemCreativeRow);
}

export async function listCreativesForItem(
  workspaceId: string,
  itemId: string,
): Promise<WeeklyPlanItemCreative[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_item_creatives")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("weekly_plan_item_id", itemId)
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list creatives.");
  return ((data ?? []) as unknown as WeeklyPlanItemCreativeRow[]).map(
    toCreative,
  );
}

export async function listCreativesForItems(
  workspaceId: string,
  itemIds: string[],
): Promise<WeeklyPlanItemCreative[]> {
  if (itemIds.length === 0) return [];
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_item_creatives")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("weekly_plan_item_id", itemIds);
  if (error) throw fromPostgres(error, "Failed to list creatives.");
  return ((data ?? []) as unknown as WeeklyPlanItemCreativeRow[]).map(
    toCreative,
  );
}

export async function getCreativeById(
  workspaceId: string,
  creativeId: string,
): Promise<WeeklyPlanItemCreative> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_item_creatives")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", creativeId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load creative.");
  if (!data) throw notFound("Creative");
  return toCreative(data as unknown as WeeklyPlanItemCreativeRow);
}

export async function updateCreative(input: {
  workspaceId: string;
  creativeId: string;
  patch: WeeklyPlanItemCreativeUpdate;
}): Promise<WeeklyPlanItemCreative> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_plan_item_creatives")
    .update(input.patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.creativeId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update creative.");
  return toCreative(data as unknown as WeeklyPlanItemCreativeRow);
}

/**
 * Phase F2.5 publish-readiness check (tightened).
 *
 * A creative is publish-ready when EVERY rule passes:
 *   1. It exists.
 *   2. status='approved' — operator approval is explicit.
 *   3. source_type !== 'planned' (placeholder is not enough).
 *   4. alt_text is non-empty (accessibility).
 *   5. asset_url OR source_url exists — a real reference, not just a
 *      prompt or a vague note.
 *   6. For external sources (wikimedia / manual_url): license AND
 *      attribution.
 *   7. For generated sources: prompt is non-empty (the audit trail
 *      records what was generated).
 *
 * Returns null on pass, or a reason code on fail.
 */
export type CreativeReadinessReason =
  | "creative_missing"
  | "creative_rejected"
  | "creative_only_planned"
  | "creative_missing_asset"
  | "creative_missing_alt_text"
  | "creative_missing_license_or_attribution"
  | "creative_missing_prompt"
  | "creative_not_approved";

export function creativeReadinessReason(
  creative: WeeklyPlanItemCreative | null,
): CreativeReadinessReason | null {
  if (!creative) return "creative_missing";
  if (creative.status === "rejected") return "creative_rejected";
  if (creative.sourceType === "planned") return "creative_only_planned";
  if (!creative.assetUrl && !creative.sourceUrl)
    return "creative_missing_asset";
  if (!creative.altText || creative.altText.trim().length === 0)
    return "creative_missing_alt_text";
  if (
    (creative.sourceType === "wikimedia" ||
      creative.sourceType === "manual_url") &&
    (!creative.license || !creative.attribution)
  ) {
    return "creative_missing_license_or_attribution";
  }
  if (
    creative.sourceType === "generated" &&
    (!creative.prompt || creative.prompt.trim().length === 0)
  ) {
    return "creative_missing_prompt";
  }
  if (creative.status !== "approved") return "creative_not_approved";
  return null;
}

/**
 * Operator-facing readiness summary for the UI badge:
 *   missing | planned | needs_review | approved | rejected
 *
 * Distinct from `creativeReadinessReason` (which is the publish gate).
 * The badge can show "needs_review" while readinessReason says
 * "creative_not_approved", which is the same state told two ways.
 */
export type CreativeReadinessBadge =
  | "missing"
  | "planned"
  | "needs_review"
  | "approved"
  | "rejected";

export function creativeReadinessBadge(
  creative: WeeklyPlanItemCreative | null,
): CreativeReadinessBadge {
  if (!creative) return "missing";
  if (creative.status === "rejected") return "rejected";
  if (creative.sourceType === "planned") return "planned";
  if (creative.status === "approved") return "approved";
  return "needs_review";
}
