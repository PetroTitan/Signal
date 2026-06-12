import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  /**
   * Optional injected client. UI / server-action callers omit it
   * and use the cookie-aware client. The scheduler tick passes its
   * service-role client through so the read is not blocked by RLS
   * in a runtime without an operator cookie. Same additive pattern
   * as getAccountById / getConnectionForAccount.
   */
  db?: SupabaseClient,
): Promise<WeeklyPlanItemCreative[]> {
  const supabase = db ?? createSupabaseServerClient();
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
 * Phase 2 — record a provider-safe derivative descriptor on the
 * creative's existing `metadata` JSONB under
 * `provider_derivatives[platform]`. Smallest-possible additive helper:
 * it touches ONLY the metadata column (no schema change), merges into
 * the existing bag (never clobbers other platforms / keys), and accepts
 * an injected client so the cron scheduler tick (service-role, no
 * cookie) can persist under RLS.
 *
 * Best-effort by contract: callers wrap this so a metadata write hiccup
 * never blocks or rolls back a publish.
 */
export async function recordProviderDerivative(input: {
  workspaceId: string;
  creativeId: string;
  platform: string;
  descriptor: Record<string, unknown>;
  db?: SupabaseClient;
}): Promise<void> {
  const supabase = input.db ?? createSupabaseServerClient();
  // Read the current metadata so we merge rather than replace.
  const { data: row, error: readError } = await supabase
    .from("weekly_plan_item_creatives")
    .select("metadata")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.creativeId)
    .maybeSingle();
  if (readError) {
    throw fromPostgres(readError, "Failed to read creative metadata.");
  }
  const current =
    ((row as { metadata?: Record<string, unknown> | null } | null)?.metadata ??
      {}) as Record<string, unknown>;
  const existingDerivatives =
    (current.provider_derivatives as Record<string, unknown> | undefined) ?? {};
  const nextMetadata = {
    ...current,
    provider_derivatives: {
      ...existingDerivatives,
      [input.platform]: input.descriptor,
    },
  };
  const { error: writeError } = await supabase
    .from("weekly_plan_item_creatives")
    .update({ metadata: nextMetadata } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.creativeId);
  if (writeError) {
    throw fromPostgres(writeError, "Failed to record provider derivative.");
  }
}

/**
 * Phase F2.5 publish-readiness check (tightened).
 *
 * A creative is publish-ready when EVERY rule passes:
 *   1. It exists.
 *   2. status='approved' — operator approval is explicit.
 *   3. source_type !== 'planned' (placeholder is not enough).
 *   4. alt_text is non-empty (accessibility).
 *   5. asset_url OR source_url OR storage_path exists — a REAL
 *      persisted asset reference, not just a prompt, alt text, or
 *      metadata note. Source-of-truth rule: prompts / metadata /
 *      aspect ratios are NEVER treated as proof of a media asset.
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

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export function creativeReadinessReason(
  creative: WeeklyPlanItemCreative | null,
): CreativeReadinessReason | null {
  if (!creative) return "creative_missing";
  if (creative.status === "rejected") return "creative_rejected";
  if (creative.sourceType === "planned") return "creative_only_planned";
  // Real asset presence: asset_url OR source_url OR storage_path.
  // storage_path covers the upload flow where the signed URL hasn't
  // been minted yet — refusing on its absence would block legitimate
  // uploaded creatives. The check matches `hasRealMediaAsset` in
  // `creative-readiness.ts` (single source of truth).
  if (
    !nonEmpty(creative.assetUrl) &&
    !nonEmpty(creative.sourceUrl) &&
    !nonEmpty(creative.storagePath)
  ) {
    return "creative_missing_asset";
  }
  if (!nonEmpty(creative.altText)) return "creative_missing_alt_text";
  if (
    (creative.sourceType === "wikimedia" ||
      creative.sourceType === "manual_url") &&
    (!nonEmpty(creative.license) || !nonEmpty(creative.attribution))
  ) {
    return "creative_missing_license_or_attribution";
  }
  if (creative.sourceType === "generated" && !nonEmpty(creative.prompt)) {
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
