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

// =====================================================================
// Title requirement contract
// =====================================================================
//
// The legacy assumption was "every plan item needs a title", enforced
// universally in `sendForApprovalAction`, the compose footer, and the
// missing-parts label. That is the wrong abstraction: a
// platform-native social post usually has NO title. X, Bluesky,
// Telegram, Threads and an Instagram caption are body-only objects —
// their publishers never read `request.title` and their transformers
// explicitly refuse to prepend it (see
// `transformers/x.ts` and `transformers/bluesky.ts`: "title is NOT
// prepended"). Requiring one forced the operator to invent a string
// that would never be published.
//
// Meanwhile three publishers DO hard-refuse without a title, and
// those refusals must be preserved:
//
//   publish-reddit.ts     → "missing_title"
//   publish-devto.ts      → "article_title_required"
//   publish-hashnode.ts   → "hashnode_title_required"
//
// So the requirement is a property of the (platform, object) pair,
// not of drafts in general. This predicate is the single place that
// decides. No `if (platform === "x")` branches belong anywhere else;
// extend the matrix here instead.
//
// Relationship to the adapters
// ----------------------------
// Each platform-native adapter already carries a `requiresTitle`
// capability flag and enforces it inside `preview()` at render time.
// That is PROVIDER-shape enforcement. This predicate is APPROVAL-time
// policy — the same split the file already draws for
// `requiresCreative`. The two agree by construction because both are
// derived from the same publisher behavior; `title-contract.test.ts`
// pins them against each other so they cannot drift.
//
// V1 matrix
// ---------
//   reddit    + any submission object            → required
//   devto     + any object                       → required
//   hashnode  + any object                       → required
//   linkedin  + article                          → required
//   youtube   + video_post / short_video         → required
//   everything else                              → optional
//
// Default is OPTIONAL. Adding a platform must not silently reinstate
// the universal rule.

/** Objects that are Reddit *submissions* (a title-bearing post) as
 *  opposed to parent-anchored comments/replies, which have none. */
const REDDIT_SUBMISSION_OBJECTS: ReadonlySet<string> = new Set([
  "post",
  "link_post",
  "media_post",
  "article",
  "new_post",
]);

/** Platforms whose every publishable object carries a title, because
 *  the publisher itself refuses without one. */
const ALWAYS_TITLED_PLATFORMS: ReadonlySet<string> = new Set([
  "devto",
  "hashnode",
]);

export interface TitlePolicyInput {
  /** weekly_plan_items.platform. Null → no destination chosen yet. */
  platform: string | null;
  /** weekly_plan_items.content_type. Free text; compared lowercased. */
  contentType?: string | null;
  /** Operator-chosen intent parsed from platform_publish_intent. */
  intent?: PublishingIntent | null;
}

/**
 * True when this item cannot be approved or published without a
 * non-empty title.
 *
 * Deliberately conservative for the three hard-refusing publishers:
 * for Reddit / dev.to / Hashnode the answer is "required" even for
 * legacy rows carrying `intent="unknown"`, because the publisher
 * gate is unconditional. Letting such an item through approval would
 * only move the failure later, to a terminal publish failure the
 * operator has to recover from.
 */
export function requiresTitle(input: TitlePolicyInput): boolean {
  const platform = (input.platform ?? "").trim().toLowerCase();
  if (platform.length === 0) return false;

  if (ALWAYS_TITLED_PLATFORMS.has(platform)) return true;

  // Normalise the object: explicit content_type wins, intent is the
  // fallback for rows created through the MCP intent path.
  const object = (input.contentType ?? "").trim().toLowerCase();
  const intent = input.intent ?? null;
  const effective =
    object.length > 0 ? object : intent && intent !== "unknown" ? intent : "";

  if (platform === "reddit") {
    // Comments and replies are parent-anchored and titleless. Legacy
    // rows with no object at all are treated as submissions, matching
    // the publisher's unconditional gate.
    if (effective === "comment" || effective === "reply") return false;
    if (effective.length === 0) return true;
    return REDDIT_SUBMISSION_OBJECTS.has(effective);
  }

  if (platform === "linkedin") return effective === "article";

  if (platform === "youtube") {
    return effective === "video_post" || effective === "short_video";
  }

  // x, bluesky, telegram, threads, instagram, indie_hackers, and any
  // future platform: titleless unless a rule above says otherwise.
  return false;
}

/**
 * Operator-facing explanation for a missing required title. Returns
 * null when no title is required, so callers can use it directly as
 * a blocker value.
 */
export function titleRequirementBlocker(
  input: TitlePolicyInput & { title: string | null },
): string | null {
  if (!requiresTitle(input)) return null;
  if (input.title !== null && input.title.trim().length > 0) return null;
  const platform = (input.platform ?? "").trim().toLowerCase();
  if (platform === "devto") return "dev.to articles require a title.";
  if (platform === "hashnode") return "Hashnode articles require a title.";
  if (platform === "reddit") return "Reddit posts require a title.";
  if (platform === "linkedin") return "LinkedIn articles require a title.";
  if (platform === "youtube") return "YouTube uploads require a title.";
  return "This destination requires a title.";
}

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
