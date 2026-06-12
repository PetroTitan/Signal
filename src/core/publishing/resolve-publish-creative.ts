/**
 * Pick the one approved creative we'll attach to a scheduled publish,
 * and validate that it carries the fields the platform requires.
 *
 * Background — the operator-trust contract
 * ----------------------------------------
 * Once a creative row is `status='approved'`, the operator has
 * committed to attaching it to the publish. Silently downgrading to
 * text-only when the row is malformed (no asset URL, no alt text) is
 * worse than failing the publish: the published post lacks the image
 * the operator approved, and there's no signal back to the UI. This
 * helper resolves the row into the wire shape the publisher expects
 * (`PublishCreative`) and returns a structured block decision when
 * the row can't be attached.
 *
 * Pure module — no I/O, no Supabase. The scheduler loads creatives
 * from the repository (with its service-role client) and feeds the
 * result here.
 */

import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";
import type { PublishCreative, PublishReasonCode } from "./publishing-types";

export type ResolveCreativeResult =
  | { kind: "none" }
  | { kind: "ready"; creative: PublishCreative }
  | {
      kind: "blocked";
      reasonCode: Extract<
        PublishReasonCode,
        "creative_missing_asset" | "creative_missing_alt_text"
      >;
      reasonDetail: string;
      creativeId: string;
    };

/**
 * Reduce the list of creatives for a plan_item to a single decision:
 *
 *   - `none`     — no approved creative; publisher continues text-only
 *                  (operator chose not to attach an image; existing
 *                  behavior is preserved).
 *   - `ready`    — one approved creative is fully populated; attach
 *                  it to the publish.
 *   - `blocked`  — at least one approved creative exists but is
 *                  missing the URL or alt text required by every
 *                  media-capable platform. The scheduler should
 *                  block the publish with the returned reason code.
 *
 * Selection rule (when multiple approved creatives exist): pick the
 * first by insertion order. The UI lists creatives in insertion order
 * and the operator's "primary" choice is the first one. Multi-image
 * attachments are deferred.
 *
 * Validation order:
 *   1. Need a fetchable URL (assetUrl OR sourceUrl).
 *   2. Need non-empty alt text (accessibility requirement; Bluesky
 *      flags missing alt as a warning even when it would accept the
 *      upload).
 */
export function resolvePublishCreative(
  creatives: ReadonlyArray<WeeklyPlanItemCreative>,
): ResolveCreativeResult {
  const approved = creatives.filter((c) => c.status === "approved");
  if (approved.length === 0) return { kind: "none" };

  // Insertion order is already the scheduler's preference.
  const primary = approved[0];

  const effectiveUrl =
    primary.assetUrl ??
    primary.sourceUrl ??
    null;
  if (!effectiveUrl || effectiveUrl.trim().length === 0) {
    return {
      kind: "blocked",
      reasonCode: "creative_missing_asset",
      reasonDetail:
        "Approved creative is missing asset_url / source_url. Re-upload the image or supply a public URL before publishing.",
      creativeId: primary.id,
    };
  }

  const alt = primary.altText?.trim() ?? "";
  if (alt.length === 0) {
    return {
      kind: "blocked",
      reasonCode: "creative_missing_alt_text",
      reasonDetail:
        "Approved creative is missing alt text. Add a one-line description so the image is accessible before publishing.",
      creativeId: primary.id,
    };
  }

  return {
    kind: "ready",
    creative: {
      id: primary.id,
      creativeType: primary.creativeType,
      sourceType: primary.sourceType,
      assetUrl: primary.assetUrl,
      sourceUrl: primary.sourceUrl,
      altText: alt,
      // Carry the stored media metadata so the provider-media-prep
      // layer can size-check against the target platform's limits
      // without a network round-trip. Null on legacy / manual-URL rows.
      mimeType: primary.mimeType,
      sizeBytes: primary.sizeBytes,
    },
  };
}

/**
 * Convenience accessor — the wire URL the publisher will fetch. Falls
 * back to sourceUrl when assetUrl isn't set (the manual-url creative
 * path stores the operator's URL on sourceUrl instead of asset_url).
 */
export function effectiveCreativeUrl(
  creative: PublishCreative,
): string | null {
  return creative.assetUrl ?? creative.sourceUrl ?? null;
}
