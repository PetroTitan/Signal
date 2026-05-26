/**
 * Phase F6.0 — platform-native publishing intent.
 *
 * Canonical type surface for the operator's platform-native shape
 * choice. Pure types + the JSONB envelope persisted on
 * weekly_plan_items.platform_publish_intent.
 *
 * Boundary rule
 * -------------
 * Provider-specific vocabularies (Bluesky's grapheme budget, X's
 * thread suffix, Reddit's subreddit target, etc.) live INSIDE each
 * adapter under src/core/platform-native/adapters/<platform>/. This
 * file owns ONLY the shared deterministic interface.
 *
 *   - No provider conditionals here.
 *   - No mutable helpers.
 *   - No I/O. No fetch. No DB.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";

// =====================================================================
// PublishingIntent — the operator's explicit shape choice
// =====================================================================

/**
 * What the operator is publishing. Distinct from how the platform
 * renders it (that's `format` on the rendered preview). Closed enum
 * so unknown future values land as the literal "unknown" rather than
 * a freeform string.
 *
 * Values are deliberately broad: not every platform supports every
 * intent. The capability matrix says which combinations are valid.
 */
export const PUBLISHING_INTENTS = [
  "new_post",
  "thread",
  "reply",
  "comment",
  "quote",
  "repost",
  "article",
  "media_post",
  "link_post",
  "video_post",
  "carousel",
  "story",
  "short_video",
  "unknown",
] as const;

export type PublishingIntent = (typeof PUBLISHING_INTENTS)[number];

export function isPublishingIntent(v: unknown): v is PublishingIntent {
  return (
    typeof v === "string" &&
    (PUBLISHING_INTENTS as readonly string[]).includes(v)
  );
}

// =====================================================================
// ThreadMode — operator's stance on splitting
// =====================================================================

/**
 * Whether the platform is allowed to split a long body into multiple
 * provider posts, and how.
 *
 *   - none: not applicable (article platforms, single-message platforms).
 *   - single_only: operator REFUSES auto-split. Publisher blocks if
 *     the rendered body would exceed the per-part budget.
 *   - auto_thread_allowed: operator OK with the platform splitting
 *     when needed. Preview must show the resulting part count and
 *     the operator's approval must hash-bind to it.
 *   - manual_thread: operator authored the thread parts explicitly
 *     (each part is its own provider post). Publisher does NOT
 *     re-split.
 *   - platform_default: defer to the platform adapter's default for
 *     this intent. Reserved; adapters that have no opinion should
 *     resolve to single_only.
 */
export const THREAD_MODES = [
  "none",
  "single_only",
  "auto_thread_allowed",
  "manual_thread",
  "platform_default",
] as const;

export type ThreadMode = (typeof THREAD_MODES)[number];

export function isThreadMode(v: unknown): v is ThreadMode {
  return typeof v === "string" && (THREAD_MODES as readonly string[]).includes(v);
}

// =====================================================================
// MediaMode — where attached media lands in the provider payload
// =====================================================================

/**
 *   - none: no media expected; operator hasn't attached any.
 *   - first_part_only: media goes on part 1 (current Bluesky
 *     behavior; first-tweet-only on X threads).
 *   - every_part: each part carries its own media (rare; reserved).
 *   - platform_default: defer to the adapter.
 *   - media_required: publish blocks if no media is attached
 *     (Instagram-class platforms).
 */
export const MEDIA_MODES = [
  "none",
  "first_part_only",
  "every_part",
  "platform_default",
  "media_required",
] as const;

export type MediaMode = (typeof MEDIA_MODES)[number];

export function isMediaMode(v: unknown): v is MediaMode {
  return typeof v === "string" && (MEDIA_MODES as readonly string[]).includes(v);
}

// =====================================================================
// Reply / quote targets — provider-native identifiers
// =====================================================================

/**
 * Provider-native pointer to an existing post we're replying to or
 * quoting. Adapters interpret the fields per their platform:
 *
 *   - Bluesky: externalId = at-uri, optionally pair with the rkey-
 *     derived URL; resolution to cid is the adapter's concern.
 *   - X: externalId = tweet id; url = https://x.com/<handle>/status/<id>
 *   - Reddit: externalId = "t1_..." (comment) or "t3_..." (post)
 *   - LinkedIn: externalId = activity URN
 */
export interface ReplyTarget {
  externalId: string | null;
  url: string | null;
}

export interface QuoteTarget {
  externalId: string | null;
  url: string | null;
}

// =====================================================================
// PlatformNativeShape — the persisted operator decision
// =====================================================================

/**
 * The operator's full platform-native shape choice for a single
 * weekly_plan_item. Persisted as JSONB at
 * weekly_plan_items.platform_publish_intent.
 *
 * `version` is the JSONB envelope version, NOT a per-platform version.
 * Bump only when the shared structure changes; per-platform vocabulary
 * widens via adapter capability matrices.
 */
export interface PlatformNativeShape {
  version: 1;
  platform: PublishPlatform;
  intent: PublishingIntent;
  threadMode: ThreadMode;
  mediaMode: MediaMode;
  expectedPartCount: number | null;
  replyTarget: ReplyTarget | null;
  quoteTarget: QuoteTarget | null;
  /**
   * Hash of the ProviderPayloadPreview the operator approved.
   * Computed via computeProviderPayloadHash. Null when no approval
   * is bound yet. Adapters that enforce shape-binding compare this
   * against the freshly-computed hash at publish time.
   */
  operatorApprovedShapeHash: string | null;
}

// =====================================================================
// ProviderPayloadPreview — the canonical preview/publish contract
// =====================================================================

/**
 * One rendered part of the provider payload. For single-post intents
 * the array has length 1; for thread intents length matches
 * expectedPartCount.
 */
export interface ProviderPayloadPart {
  index: number;
  text: string;
  media: {
    attached: boolean;
    target: "this_part" | "none";
    altText: string | null;
  };
}

export interface ProviderPayloadBlocker {
  code: string;
  message: string;
}

/**
 * Coarse render shape — the rendered category, not the operator's
 * intent. (intent = "thread" + format = "thread" are different
 * conceptually: the operator chose thread; the renderer produced one.)
 *
 * "unknown" is the explicit sentinel for stub adapters. Code that
 * sees "unknown" MUST treat the preview as advisory only.
 */
export const PROVIDER_PAYLOAD_FORMATS = [
  "single_post",
  "thread",
  "reply",
  "quote",
  "article",
  "media_post",
  "link_post",
  "video_post",
  "unknown",
] as const;

export type ProviderPayloadFormat = (typeof PROVIDER_PAYLOAD_FORMATS)[number];

export interface ProviderPayloadPreview {
  platform: PublishPlatform;
  intent: PublishingIntent;
  format: ProviderPayloadFormat;
  parts: ReadonlyArray<ProviderPayloadPart>;
  warnings: ReadonlyArray<string>;
  blockers: ReadonlyArray<ProviderPayloadBlocker>;
  // NB: the payload hash is a DERIVED async property of this preview.
  // It is computed via computeProviderPayloadHash(preview) so the
  // adapter layer stays sync and platform-agnostic. Approval binding
  // code is the only consumer that needs the hash.
}

// =====================================================================
// Defaults — used by the repository layer when a row has no intent
// =====================================================================

/**
 * Build a legacy-mode shape for an existing row that has no
 * platform_publish_intent. The shape signals "operator hasn't picked
 * yet" so the UI can render a "Legacy payload mode" badge AND
 * downstream adapters know not to enforce shape-binding.
 *
 * intent: "unknown" — NOT a fake "new_post" default. The operator
 * choice is genuinely absent; we don't pretend otherwise.
 */
export function legacyPlatformNativeShape(
  platform: PublishPlatform,
): PlatformNativeShape {
  return {
    version: 1,
    platform,
    intent: "unknown",
    threadMode: "platform_default",
    mediaMode: "platform_default",
    expectedPartCount: null,
    replyTarget: null,
    quoteTarget: null,
    operatorApprovedShapeHash: null,
  };
}

/**
 * Parse a JSONB envelope read from the DB. Returns null when the
 * envelope is malformed (so the caller can fall back to legacy mode
 * instead of crashing on a future-version row).
 *
 * The parser is intentionally strict on the FIXED fields and
 * permissive on the EXTENSIBLE ones — unknown intent / threadMode /
 * mediaMode values resolve to their respective "unknown" / "platform_
 * default" sentinels so a future writer can land new vocabulary
 * without breaking the reader.
 */
export function parsePlatformNativeShape(
  raw: unknown,
  platform: PublishPlatform,
): PlatformNativeShape | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  // platform mismatch is a real bug — refuse rather than silently
  // accept a payload that targets a different provider.
  if (typeof obj.platform === "string" && obj.platform !== platform) {
    return null;
  }
  const intent: PublishingIntent = isPublishingIntent(obj.intent)
    ? obj.intent
    : "unknown";
  const threadMode: ThreadMode = isThreadMode(obj.threadMode)
    ? obj.threadMode
    : "platform_default";
  const mediaMode: MediaMode = isMediaMode(obj.mediaMode)
    ? obj.mediaMode
    : "platform_default";
  const expectedPartCount =
    typeof obj.expectedPartCount === "number" &&
    Number.isInteger(obj.expectedPartCount) &&
    obj.expectedPartCount > 0
      ? obj.expectedPartCount
      : null;
  const replyTarget = parseTarget(obj.replyTarget);
  const quoteTarget = parseTarget(obj.quoteTarget);
  const operatorApprovedShapeHash =
    typeof obj.operatorApprovedShapeHash === "string"
      ? obj.operatorApprovedShapeHash
      : null;
  return {
    version: 1,
    platform,
    intent,
    threadMode,
    mediaMode,
    expectedPartCount,
    replyTarget,
    quoteTarget,
    operatorApprovedShapeHash,
  };
}

function parseTarget(raw: unknown): ReplyTarget | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const externalId =
    typeof obj.externalId === "string" && obj.externalId.length > 0
      ? obj.externalId
      : null;
  const url =
    typeof obj.url === "string" && obj.url.length > 0 ? obj.url : null;
  if (externalId === null && url === null) return null;
  return { externalId, url };
}

/**
 * Serialize a shape back to the JSONB envelope. Keys are emitted in
 * a stable order so DB-side jsonb_pretty output stays diff-friendly.
 */
export function serializePlatformNativeShape(
  shape: PlatformNativeShape,
): Record<string, unknown> {
  return {
    version: shape.version,
    platform: shape.platform,
    intent: shape.intent,
    threadMode: shape.threadMode,
    mediaMode: shape.mediaMode,
    expectedPartCount: shape.expectedPartCount,
    replyTarget: shape.replyTarget
      ? { externalId: shape.replyTarget.externalId, url: shape.replyTarget.url }
      : null,
    quoteTarget: shape.quoteTarget
      ? { externalId: shape.quoteTarget.externalId, url: shape.quoteTarget.url }
      : null,
    operatorApprovedShapeHash: shape.operatorApprovedShapeHash,
  };
}
