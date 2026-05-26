/**
 * Pure helpers for /weekly-plan UI warning surfaces.
 *
 * Two display layers in `page.tsx` previously coupled the creative
 * gate to `content_type === "post"`:
 *
 *   1. The amber "Resolve before approval" banner on each plan-item
 *      card ("Creative not ready: creative missing.")
 *   2. The "Continue writing drafts" missingParts label
 *      ("missing: title, body, schedule, creative")
 *
 * Both surfaces lied for platforms where the central policy
 * (`requiresCreative`) returns false — most visibly Telegram channel
 * messages and Bluesky text posts, which have `content_type === "post"`
 * but don't actually need a creative.
 *
 * This module owns the decision. Server-side approval already
 * consults `requiresCreative` correctly via
 * `assessItemApprovalReadiness`; this brings the UI in line.
 *
 * Rule
 * ----
 * The creative gate fires when EITHER:
 *   - `requiresCreative({platform, intent}) === true` (Instagram,
 *     YouTube + video_post, media_post / carousel / story /
 *     short_video intents on any platform), OR
 *   - a creative IS attached but is malformed (missing asset URL,
 *     missing alt text, planned-only with no asset, etc.) — the
 *     operator attached something, so they expect it to be
 *     validated even on optional-creative platforms.
 *
 * The second clause mirrors Bluesky's orchestrator-time enforcement:
 * an operator who attaches an image but forgets alt text still
 * needs to know before publish time.
 *
 * Pure module. No I/O. No platform-specific branching outside
 * `requiresCreative` (which itself is the single source of truth).
 */

import type { CreativeReadinessReason } from "@/repositories/weekly-plan-creative-repository";
import { requiresCreative } from "@/core/platform-native/approval-policy";
import type { PublishingIntent } from "@/core/platform-native/publishing-intent";

export interface CreativeGateInput {
  /** weekly_plan_items.platform. Null tolerated. */
  platform: string | null;
  /** Operator-chosen intent (parsed from platform_publish_intent).
   *  Null / "unknown" → treated as legacy / no-explicit-intent. */
  intent: PublishingIntent | null;
  /** True when a creative row exists for this plan item (regardless
   *  of whether the creative is well-formed). */
  creativeAttached: boolean;
  /** Result of `creativeReadinessReason(creative)`. Null when the
   *  creative is fully ready. */
  creativeReason: CreativeReadinessReason | null;
}

/**
 * True when the creative gate should fire — i.e. surface a warning
 * to the operator. Encapsulates the two-clause rule above.
 */
export function shouldFireCreativeGate(input: CreativeGateInput): boolean {
  const policyRequired = requiresCreative({
    platform: input.platform,
    intent: input.intent,
  });
  if (policyRequired) {
    // Policy says creative is required. Any non-null reason is a
    // blocker; null reason means a ready creative exists, nothing to
    // warn about.
    return input.creativeReason !== null;
  }
  // Policy says optional. We only warn when a creative was attached
  // AND is malformed. "No creative attached" on an optional-creative
  // platform is the steady state, not a warning.
  return input.creativeAttached && input.creativeReason !== null;
}

/**
 * Pure helper for the "Continue writing drafts" missingParts label.
 * Mirrors the existing missing-parts collection logic; the only
 * change is replacing `content_type === "post"` with
 * `shouldFireCreativeGate`.
 *
 * Other missing-parts entries (title / body / schedule) stay
 * coupled to content_type === "post" — those are independent of the
 * creative policy and weren't the source of the drift.
 */
export interface ContinueWritingMissingPartsInput {
  contentType: string | null;
  title: string | null;
  body: string | null;
  scheduledAt: string | null;
  platform: string | null;
  intent: PublishingIntent | null;
  creativeAttached: boolean;
  creativeReason: CreativeReadinessReason | null;
}

export function computeContinueWritingMissingParts(
  input: ContinueWritingMissingPartsInput,
): string[] {
  const missingParts: string[] = [];
  const isPost = input.contentType === "post";

  if (!input.title || input.title.trim().length === 0) {
    missingParts.push("title");
  }
  if (!input.body || input.body.trim().length === 0) {
    missingParts.push("body");
  }
  if (isPost && !input.scheduledAt) {
    missingParts.push("schedule");
  }
  if (
    shouldFireCreativeGate({
      platform: input.platform,
      intent: input.intent,
      creativeAttached: input.creativeAttached,
      creativeReason: input.creativeReason,
    })
  ) {
    missingParts.push("creative");
  }
  return missingParts;
}

/**
 * Pure helper for the per-card warning banner. Returns the array of
 * warning strings to render in the amber "Resolve before approval"
 * box, in display order.
 *
 * Like `computeContinueWritingMissingParts`, only the creative gate
 * is policy-aware now. The "missing schedule" warning stays coupled
 * to content_type === "post" (every post-style platform needs a
 * schedule regardless of creative policy).
 */
export interface PlanItemWarningsInput {
  contentType: string | null;
  scheduledAt: string | null;
  platform: string | null;
  intent: PublishingIntent | null;
  creativeAttached: boolean;
  creativeReason: CreativeReadinessReason | null;
}

export function computePlanItemWarnings(
  input: PlanItemWarningsInput,
): string[] {
  const warnings: string[] = [];
  const isPost = input.contentType === "post";

  if (isPost && !input.scheduledAt) {
    warnings.push("Missing schedule — set a date/time before approving.");
  }
  if (
    shouldFireCreativeGate({
      platform: input.platform,
      intent: input.intent,
      creativeAttached: input.creativeAttached,
      creativeReason: input.creativeReason,
    }) &&
    input.creativeReason
  ) {
    warnings.push(
      `Creative not ready: ${input.creativeReason.replace(/_/g, " ")}.`,
    );
  }
  return warnings;
}
