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

/**
 * Read-model selector — pick THE primary creative for a plan_item
 * when more than one row exists.
 *
 * Multiple rows happen in production:
 *   - the prepare_item flow drops a `planned` placeholder (no asset)
 *   - then `signal.upload_creative_asset` adds the real asset-backed
 *     row later
 *   - operators / Codex may upload a replacement, leaving the
 *     earlier asset-backed row in place for audit
 *
 * Pre-fix the read tool returned the first row by `created_at ASC`,
 * which kept surfacing the planned placeholder even after a real
 * asset was uploaded. This helper encodes the operator-facing rule:
 *
 *   Presence dominates status. A row with `storage_path` (canonical
 *   workspace upload) outranks an `asset_url`-only row regardless
 *   of status — including legacy `generated/approved` rows whose
 *   `asset_url` is a `data:` URL with no workspace storage backing.
 *
 *     storage_path present       > asset_url only > source_url only.
 *
 *   Within the same presence tier: approved > pending_review >
 *   planned (derived asset_ready) > rejected.
 *
 *   Within the same combined tier: newest `createdAt` wins.
 *
 * Planned placeholders are only chosen when NO asset-backed row
 * exists for the item. Historical placeholders are never deleted
 * or mutated by this selector — it only picks the "current" one.
 *
 * Pure. Exported for tests.
 */
export interface SelectableCreative extends CreativeReadinessInput {
  /** Stable identifier used by the caller's projection. */
  id: string;
  /** ISO timestamp used to break ties within the same tier. */
  createdAt: string;
}

/**
 * Numeric priority for a creative row. Higher = preferred. Pure.
 *
 * Two signals are encoded into one score:
 *
 *   - Presence tier (PRIMARY): which of the persisted asset
 *     columns is set. `storage_path` is the canonical workspace
 *     bucket key; `asset_url` without `storage_path` is a legacy
 *     pattern (data: URLs from the old generated flow, or
 *     externally hosted URLs); `source_url`-only is a degenerate
 *     re-attach or an external-source reference.
 *
 *       storage_path present (uploaded canonical)        → tier 12
 *       asset_url only       (legacy generated / hosted) → tier  8
 *       source_url only      (external / degenerate)     → tier  4
 *       no asset or source_type='planned'                → tier  0
 *
 *   - Status sub-rank (SECONDARY, within the same presence tier):
 *
 *       approved        → +3
 *       pending_review  → +2
 *       planned status  → +1  (asset_ready)
 *       rejected        → +0
 *
 * Resulting values: 0, then 4..15 in the asset-present band.
 *
 * Why presence dominates status: a "real" upload (storage_path)
 * MUST outrank a legacy `generated/approved` row whose `asset_url`
 * is a `data:` URL with no workspace storage backing. This is the
 * concrete production state for plan_item 41354be5: row
 * `95695e78` is generated/approved with a base64 data URL; row
 * `dc03ca25` is uploaded/pending_review with `storage_path`. The
 * uploaded row is the operator's actual current asset; the
 * legacy approved row is stale.
 *
 * Within the storage-backed tier (12+) status still wins, so a
 * normal `approved-uploaded-with-storage_path` continues to
 * outrank a `pending_review-uploaded-with-storage_path`.
 */
export function creativeSelectionPriority(
  creative: CreativeReadinessInput,
): number {
  if (!hasRealMediaAsset(creative)) return 0;
  if (creative.sourceType === "planned") return 0;
  let presenceTier: number;
  if (nonEmpty(creative.storagePath)) {
    presenceTier = 12;
  } else if (nonEmpty(creative.assetUrl)) {
    presenceTier = 8;
  } else {
    // hasRealMediaAsset returned true, so source_url must be set.
    presenceTier = 4;
  }
  let statusBoost: number;
  if (creative.status === "approved") statusBoost = 3;
  else if (creative.status === "pending_review") statusBoost = 2;
  else if (creative.status === "planned") statusBoost = 1;
  // status === "rejected" — kept selectable but ranked below other
  // statuses in the same presence tier.
  else statusBoost = 0;
  return presenceTier + statusBoost;
}

/**
 * Pick the primary creative for one plan_item from a candidate list.
 * Returns null when the list is empty.
 *
 * Two-key ordering: (priority DESC, createdAt DESC).
 */
export function selectPrimaryCreative<T extends SelectableCreative>(
  candidates: ReadonlyArray<T>,
): T | null {
  if (candidates.length === 0) return null;
  let best: T = candidates[0];
  let bestPriority = creativeSelectionPriority(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const priority = creativeSelectionPriority(candidate);
    if (priority > bestPriority) {
      best = candidate;
      bestPriority = priority;
      continue;
    }
    if (priority === bestPriority) {
      // Tie-breaker: newest createdAt wins.
      if (candidate.createdAt > best.createdAt) {
        best = candidate;
      }
    }
  }
  return best;
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
