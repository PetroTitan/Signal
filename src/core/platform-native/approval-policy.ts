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

// =====================================================================
// Phase F7.4 — approvable publish object policy
// =====================================================================
//
// The legacy assumption "only items with content_type='post' can be
// approved" rejected every dev.to / Hashnode article (and every
// future article-shaped platform). Signal is a platform-native
// publishing system; the approvable set is the set of valid
// platform-native publish objects.
//
// V1 explicit allowlist (the spec's enumeration):
//   - post                     (legacy text-post default)
//   - article                  (dev.to, Hashnode, LinkedIn article)
//   - thread                   (X, Threads, Bluesky)
//   - media_post               (any platform)
//   - video_post               (YouTube)
//   - carousel                 (Instagram, LinkedIn document)
//   - reply / comment          (Bluesky, X, Threads, Reddit)
//   - quote                    (X, Threads)
//   - link_post                (Reddit, LinkedIn share)
//   - community_post           (YouTube community)
//   - channel_message          (Telegram)
//   - group_message            (Telegram)
//   - story / short_video      (Instagram, YouTube Shorts)
//
// Anything else (unknown, malformed, debug-only, empty, etc.) is
// NOT approvable. The UI surfaces neutral copy:
//   "This item is not a publishable platform object yet."
//
// Legacy items predating platform-native intent typically carry
// content_type='post' (the MCP default) and remain approvable.

export interface ApprovableObjectInput {
  /** weekly_plan_items.platform. Null tolerated for legacy rows. */
  platform: string | null;
  /** weekly_plan_items.content_type — free-text column. The check is
   *  against an explicit allowlist; case-insensitive. */
  contentType: string | null;
  /** Optional intent override (parsed from platform_publish_intent).
   *  When set AND the contentType is null/empty, the intent acts as
   *  the object signal — e.g. a row created via the MCP intent path
   *  without an explicit content_type. */
  intent?: PublishingIntent | null;
  /** Reserved for future axis-3 rules; v1 ignores. */
  format?: string | null;
}

const APPROVABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "post",
  "article",
  "thread",
  "media_post",
  "video_post",
  "carousel",
  "reply",
  "comment",
  "quote",
  "repost",
  "link_post",
  "community_post",
  "channel_message",
  "group_message",
  "story",
  "short_video",
]);

const APPROVABLE_INTENTS: ReadonlySet<PublishingIntent> = new Set<PublishingIntent>([
  "new_post",
  "article",
  "thread",
  "reply",
  "comment",
  "quote",
  "repost",
  "media_post",
  "link_post",
  "video_post",
  "carousel",
  "story",
  "short_video",
]);

/**
 * True when the (platform, contentType, intent) tuple describes a
 * publishable platform-native object that the operator may approve.
 *
 * The decision lives HERE so callers (UI + server actions + future
 * MCP enforcement) all agree. No `if (contentType === "article")`
 * branches should appear anywhere else in the codebase — add to the
 * allowlist instead.
 *
 * Returns false for:
 *   - empty / whitespace-only contentType when no intent is set
 *   - unknown contentType values not in the allowlist (and no
 *     approvable intent)
 *   - explicit "unknown" intent without a recognized contentType
 */
export function isApprovablePublishObject(
  input: ApprovableObjectInput,
): boolean {
  const normalized = (input.contentType ?? "").trim().toLowerCase();
  if (normalized.length > 0) {
    return APPROVABLE_CONTENT_TYPES.has(normalized);
  }
  // No explicit contentType — try the intent (MCP intent path may
  // leave contentType null on rows where intent carries the signal).
  if (input.intent && input.intent !== "unknown") {
    return APPROVABLE_INTENTS.has(input.intent);
  }
  return false;
}
