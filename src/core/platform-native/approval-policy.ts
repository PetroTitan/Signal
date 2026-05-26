/**
 * Phase F7.3 — platform-native approval policy.
 *
 * Single source of truth for whether the operator approval gate
 * needs to validate an attached creative. The legacy assumption
 * "every post needs a creative" doesn't fit article / text-first
 * platforms (dev.to, Hashnode, Reddit text, LinkedIn article,
 * Bluesky text, X text, Telegram text), so the gate now consults
 * this module instead.
 *
 * Hard rules
 * ----------
 *   - Pure module. No I/O. No platform-specific branching outside
 *     `requiresCreative` itself.
 *   - Per-platform decisions live HERE, never duplicated inside
 *     adapters, UI components, server actions, or scheduler code.
 *   - Adapters keep their OWN provider-time validation (Bluesky alt
 *     text, Instagram media URL, etc.) — that's render/publish-time
 *     enforcement, distinct from approval-time policy.
 *
 * Version 1 matrix
 * ----------------
 *   Instagram (any intent)                        → required
 *   intent ∈ {media_post, carousel, story,
 *             short_video} (any platform)         → required
 *   YouTube + intent=video_post                   → required
 *   Everything else                                → optional
 *
 * Future extensions add cases above the default; the default stays
 * "optional" so adding a new platform doesn't accidentally bring
 * back the legacy "every post needs a creative" assumption.
 */

import type { PublishingIntent } from "./publishing-intent";

export interface ApprovalPolicyInput {
  /** growth_accounts.platform. Null when the row predates platform
   *  tagging — treated as no-platform / optional. */
  platform: string | null;
  /** Operator-chosen intent (parsed from platform_publish_intent).
   *  Null / "unknown" → treated as legacy / no-explicit-intent. */
  intent: PublishingIntent | null;
  /** Optional rendered format hint (for future axis-3 rules; v1
   *  policy doesn't read this — the intent enum already covers
   *  media_post / carousel / story / short_video). */
  format?: string | null;
}

/**
 * True when operator approval REQUIRES a publish-ready creative.
 * False when the creative is optional — approval can succeed
 * without one.
 *
 * Default: optional. The function only returns true for the small
 * set of platform / intent combinations listed in the v1 matrix.
 */
export function requiresCreative(input: ApprovalPolicyInput): boolean {
  // Per-intent mandates apply on any platform. Intent is the
  // strongest signal: media_post / carousel / story / short_video
  // explicitly say "this is a media-first post" regardless of which
  // platform it lands on.
  if (
    input.intent === "media_post" ||
    input.intent === "carousel" ||
    input.intent === "story" ||
    input.intent === "short_video"
  ) {
    return true;
  }

  // Per-platform mandate: Instagram is media-first; every IG intent
  // requires media. (Already covered for media_post/carousel/story/
  // short_video above; this catches the legacy `intent=null` case
  // and the "unknown" sentinel.)
  if (input.platform === "instagram") return true;

  // Per (platform, intent) mandate: YouTube video uploads require
  // a video creative (or at minimum a thumbnail asset). Community
  // posts (intent=new_post) stay optional.
  if (input.platform === "youtube" && input.intent === "video_post") {
    return true;
  }

  return false;
}

// Re-exported for callers that want the future-extensible shape
// without locking themselves to the boolean return today.
export interface ApprovalPolicy {
  creativeRequired: boolean;
}

export function getApprovalPolicy(
  input: ApprovalPolicyInput,
): ApprovalPolicy {
  return { creativeRequired: requiresCreative(input) };
}
