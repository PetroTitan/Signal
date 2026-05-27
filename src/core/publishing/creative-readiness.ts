/**
 * Creative readiness — derived state model.
 *
 * Source-of-truth rule: readiness is derived from PERSISTED COLUMNS
 * ONLY. Prompts, metadata, alt text, aspect ratio, license, and
 * attribution are NEVER treated as proof of a real media asset.
 * The single asset-presence signal is whether at least one of
 *   - asset_url
 *   - source_url
 *   - storage_path
 * carries a non-empty string. Any other interpretation is wrong.
 *
 * State machine (DERIVED — not persisted as a column today):
 *
 *      planned ── attach asset ──▶ asset_ready
 *      planned ── (start generation, future) ──▶ generating
 *      generating ── asset arrives ──▶ asset_ready
 *      asset_ready ── operator submits ──▶ pending_review
 *      pending_review ── operator approves ──▶ approved
 *      pending_review ── operator rejects ──▶ rejected
 *
 * Mapped from the existing persisted shape (status × source_type ×
 * asset-presence). Existing DB columns are unchanged:
 *
 *   status      ∈ {planned, pending_review, approved, rejected}
 *   source_type ∈ {planned, generated, uploaded, wikimedia,
 *                  official_source, manual_url}
 *
 * Pure module — no I/O. Safe to import from anywhere.
 */

import type {
  CreativeSourceType,
  CreativeStatus,
} from "@/lib/supabase/types";

/**
 * Minimal creative shape this module reads. Both
 * `WeeklyPlanItemCreative` (repo domain) and any future read model
 * extending it satisfy this contract.
 */
export interface CreativeReadinessInput {
  status: CreativeStatus;
  sourceType: CreativeSourceType;
  assetUrl: string | null;
  sourceUrl: string | null;
  /**
   * Storage path inside the workspace-scoped Supabase bucket. The
   * presence helper treats this as equivalent to assetUrl/sourceUrl
   * because uploaded creatives may have only a storage path until
   * the signed URL is minted.
   */
  storagePath: string | null;
  altText: string | null;
  prompt: string | null;
  license: string | null;
  attribution: string | null;
}

/**
 * Single asset-presence helper. Used everywhere — adapters, MCP
 * attach, approval guards, the read model.
 *
 * Returns true iff at least one of the three persisted asset
 * references is a non-empty string. Trims whitespace defensively.
 */
export function hasRealMediaAsset(
  creative: CreativeReadinessInput,
): boolean {
  return (
    nonEmpty(creative.assetUrl) ||
    nonEmpty(creative.sourceUrl) ||
    nonEmpty(creative.storagePath)
  );
}

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Derived readiness state — what the UI / read model / approval
 * gate should consult.
 *
 *   - `planned`        — placeholder; no asset yet (legitimate)
 *   - `generating`     — operator started generation, asset not in yet (future-safe)
 *   - `asset_ready`    — a real asset is attached; not yet submitted for review
 *   - `pending_review` — operator submitted; awaiting approval decision
 *   - `approved`       — operator approved; ready to publish
 *   - `rejected`       — operator rejected
 *   - `needs_action`   — INVALID state: persisted as pending_review/
 *                        approved but missing the underlying asset.
 *                        This is the bug class the readiness layer
 *                        catches. UI should surface "missing asset"
 *                        and publishers refuse.
 */
export type CreativeReadinessState =
  | "planned"
  | "generating"
  | "asset_ready"
  | "pending_review"
  | "approved"
  | "rejected"
  | "needs_action";

/**
 * Map a persisted creative row to its derived readiness state.
 *
 * Precedence:
 *   1. status='rejected'                                          → rejected
 *   2. source_type='planned' (placeholder)                        → planned
 *   3. status='approved'    + has asset                            → approved
 *      status='approved'    + NO asset                             → needs_action
 *   4. status='pending_review' + has asset                         → pending_review
 *      status='pending_review' + NO asset                          → needs_action
 *      (production-state regression: source_type='generated' but
 *       no real asset persisted — was the false-ready state the
 *       feature aims to eliminate)
 *   5. status='planned'      + has asset                           → asset_ready
 *   6. status='planned'      + NO asset                            → planned
 */
export function deriveCreativeReadinessState(
  creative: CreativeReadinessInput,
): CreativeReadinessState {
  if (creative.status === "rejected") return "rejected";
  if (creative.sourceType === "planned") return "planned";
  const assetPresent = hasRealMediaAsset(creative);
  if (creative.status === "approved") {
    return assetPresent ? "approved" : "needs_action";
  }
  if (creative.status === "pending_review") {
    return assetPresent ? "pending_review" : "needs_action";
  }
  // status === "planned" but source_type !== "planned"
  return assetPresent ? "asset_ready" : "planned";
}

/**
 * The set of derived states that mean the creative is REAL and
 * ready for downstream consumers (UI carousels, publishers, audit).
 */
export function isCreativeReady(state: CreativeReadinessState): boolean {
  return (
    state === "asset_ready" ||
    state === "pending_review" ||
    state === "approved"
  );
}

/**
 * Approval guard. Returns null when the creative may transition
 * to `approved`; otherwise returns a stable reason code.
 *
 * Caller is responsible for surfacing operator-facing copy — the
 * existing `creativeBlockerCopy` helper maps these codes to UI
 * strings.
 *
 * The check is STRICTER than the persistence layer:
 *   - prompt-only creatives (source_type='generated' + no asset)
 *     are blocked here even if the DB row has status='pending_review'.
 *   - the bug class is "false ready" — operator could otherwise
 *     approve a row that publishers would later refuse.
 */
export type ApprovalBlocker =
  | "creative_missing_asset"
  | "creative_only_planned"
  | "creative_missing_alt_text"
  | "creative_missing_license_or_attribution"
  | "creative_missing_prompt"
  | "creative_rejected";

export function assertApprovable(
  creative: CreativeReadinessInput,
): ApprovalBlocker | null {
  if (creative.status === "rejected") return "creative_rejected";
  // Prompt-only / placeholder creatives can't be approved at all.
  if (creative.sourceType === "planned") return "creative_only_planned";
  // The asset must actually exist on disk / on a URL.
  if (!hasRealMediaAsset(creative)) return "creative_missing_asset";
  if (!nonEmpty(creative.altText)) return "creative_missing_alt_text";
  if (
    (creative.sourceType === "wikimedia" ||
      creative.sourceType === "manual_url") &&
    (!nonEmpty(creative.license) || !nonEmpty(creative.attribution))
  ) {
    return "creative_missing_license_or_attribution";
  }
  if (
    creative.sourceType === "generated" &&
    !nonEmpty(creative.prompt)
  ) {
    return "creative_missing_prompt";
  }
  return null;
}

/**
 * MCP-attach validator.
 *
 * Refuses prompt-only "generated" creatives at the attach boundary
 * so the false-ready state can't be persisted again. The route
 * surfaces the returned reason as a 400 with operator-facing copy.
 *
 *   - `source_type === 'generated'` REQUIRES a real asset reference
 *     (asset_url OR source_url; storage_path arrives via the upload
 *     flow, not MCP attach). Without one, the operator is sending a
 *     prompt only — should use `source_type='planned'` instead.
 *   - Other source types keep their existing per-source validation
 *     (handled by the schema parser).
 *
 * Pure. The caller (`weeklyPlanAttachCreative`) calls this BEFORE
 * the insert.
 */
export type AttachRefusal =
  | "generated_requires_asset_use_planned"
  | "generated_requires_prompt"
  | "external_source_requires_url";

export interface AttachValidationInput {
  sourceType: CreativeSourceType;
  assetUrl: string | null;
  sourceUrl: string | null;
  prompt: string | null;
}

export function validateAttachInput(
  input: AttachValidationInput,
): AttachRefusal | null {
  if (input.sourceType === "generated") {
    // Generated creatives need a real asset reference. A prompt is
    // an audit signal, not proof of media.
    if (!nonEmpty(input.assetUrl) && !nonEmpty(input.sourceUrl)) {
      return "generated_requires_asset_use_planned";
    }
    if (!nonEmpty(input.prompt)) {
      return "generated_requires_prompt";
    }
    return null;
  }
  if (
    input.sourceType === "wikimedia" ||
    input.sourceType === "manual_url"
  ) {
    if (!nonEmpty(input.sourceUrl)) {
      return "external_source_requires_url";
    }
  }
  return null;
}
