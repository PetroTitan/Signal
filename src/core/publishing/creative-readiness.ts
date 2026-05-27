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
 *   Asset-backed > not asset-backed.
 *   Within asset-backed: approved > pending_review > planned
 *     (derived asset_ready) > rejected.
 *   Within the same status tier: storage-backed (storage_path or
 *     asset_url present) > source-url-only.
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
 *   - Status tier (primary): approved > pending_review > planned
 *     (asset_ready) > rejected > no asset.
 *   - Storage sub-tier (secondary, within the same status tier):
 *     storage-backed (storage_path OR asset_url set) outranks
 *     source-url-only.
 *
 *   no asset (or source_type='planned')           → 0
 *   rejected + source_url only                    → 1
 *   rejected + storage-backed                     → 2
 *   planned (asset_ready) + source_url only       → 3
 *   planned (asset_ready) + storage-backed        → 4
 *   pending_review + source_url only              → 5
 *   pending_review + storage-backed               → 6
 *   approved + source_url only                    → 7
 *   approved + storage-backed                     → 8
 *
 * Storage sub-tier rationale: a properly uploaded creative carries
 * `storage_path` (workspace bucket key) and the derived `asset_url`.
 * A `source_url`-only row for `source_type='uploaded'` is a
 * degenerate re-attach where the canonical storage tuple is missing
 * — we surface the storage-backed row instead so the UI / publishers
 * see the operator's actual upload, not a partial second row.
 * External-source creatives (`wikimedia`, `manual_url`) legitimately
 * carry only `source_url`; they still win against tier 0 and against
 * other source-url-only rows by recency.
 */
export function creativeSelectionPriority(
  creative: CreativeReadinessInput,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  if (!hasRealMediaAsset(creative)) return 0;
  if (creative.sourceType === "planned") return 0;
  const storageBoost: 0 | 1 =
    nonEmpty(creative.assetUrl) || nonEmpty(creative.storagePath) ? 1 : 0;
  if (creative.status === "approved") return (7 + storageBoost) as 7 | 8;
  if (creative.status === "pending_review") return (5 + storageBoost) as 5 | 6;
  // status === "planned" + asset present → derived "asset_ready"
  if (creative.status === "planned") return (3 + storageBoost) as 3 | 4;
  // status === "rejected" + asset present — kept selectable so the
  // operator can see the rejection state, but ranked below every
  // other asset-backed row.
  return (1 + storageBoost) as 1 | 2;
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
