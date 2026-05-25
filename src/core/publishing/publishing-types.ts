/**
 * Phase F1 — publishing types.
 *
 * The publishing layer is the bridge between an approved
 * `weekly_plan_items` row and the platform's official posting API.
 * It is intentionally narrow: text posts and (for Reddit only) link
 * posts. No comments, DMs, voting, moderation, or scraping.
 */

export type PublishPlatform =
  | "reddit"
  | "x"
  | "linkedin"
  | "devto"
  | "hashnode"
  | "bluesky"
  | "youtube"
  | "threads"
  | "instagram"
  | "telegram";

export type PublishMode = "dry_run" | "live";

export const PUBLISH_STATUSES = [
  "published",
  "failed",
  "skipped",
  "blocked",
  "not_implemented",
] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const PUBLISH_REASON_CODES = [
  "ok",
  "no_active_contract",
  "account_not_confirmed",
  "product_not_confirmed",
  "oauth_not_connected",
  "oauth_token_not_stored",
  "execution_mode_dry_run",
  "publishing_disabled",
  "scheduled_in_future",
  "risk_level_blocked",
  "platform_not_supported",
  "platform_api_error",
  "platform_rate_limited",
  "platform_unauthorized",
  "missing_subreddit",
  "missing_body",
  "missing_title",
  "missing_api_key",
  "missing_publication_id",
  "missing_identifier",
  "duplicate_post",
  "body_too_long",
  "cadence_cooldown",
  "safe_test_mode_ready_for_publish",
  "unknown_error",
  // Phase F5.4 — identity-scoped publishing codes for Bluesky.
  // `reason_code` is a free-text column in publish_history (no DB
  // CHECK), so this is a pure TS-side widening.
  "session_missing",
  "session_expired",
  "handle_mismatch",
  "missing_account",
  "platform_mismatch",
  // Synthesized by the scheduler when publishOne throws before
  // applyOutcome can persist a real outcome. Guarantees the
  // execution_item moves out of "scheduled" even on unexpected
  // exceptions.
  "scheduler_exception",
  // PR 1 — bluesky-publish-approved-creative
  // An approved creative is attached to the plan_item but the row
  // is missing the asset URL / source URL / alt text Bluesky
  // requires. Block (rather than silently downgrade) so the
  // operator can fix the creative.
  "creative_missing_asset",
  "creative_missing_alt_text",
  // The Bluesky uploadBlob call rejected the image (oversized,
  // unsupported type, network error). Surfaces as a real publish
  // failure rather than letting the orchestrator publish text-only.
  "media_upload_failed",
] as const;
export type PublishReasonCode = (typeof PUBLISH_REASON_CODES)[number];

export interface PublishRequest {
  /** Workspace owning the execution item. */
  workspaceId: string;
  /** weekly_plan_items.id this request belongs to. */
  planItemId: string;
  /** execution_items.id (the runner attaches the published artifact here). */
  executionItemId: string;
  platform: PublishPlatform;
  /** Resolved account row. */
  accountId: string;
  /** Optional product row. */
  productId: string | null;
  /** Title for the post; required for Reddit. */
  title: string | null;
  /** Body / selftext. */
  body: string | null;
  /** Optional link URL — converts the Reddit post to a link post when set. */
  linkUrl: string | null;
  /** Subreddit (without `r/`) or platform-specific routing target. */
  target: string | null;
  /** Workspace publishing mode (dry_run | live). */
  mode: PublishMode;
  // ------------------------------------------------------------------
  // Canonical-post extensions used by dev.to / Hashnode / Bluesky.
  // Each is optional — Reddit ignores them. Platforms read only what
  // they need; transformers must not depend on any single field.
  // ------------------------------------------------------------------
  /** Plain-text summary for SEO surfaces (dev.to/Hashnode). */
  summary?: string | null;
  /** Tags as an array of bare words (no '#'). */
  tags?: string[];
  /** Canonical URL on the operator's own site, if any. */
  canonicalUrl?: string | null;
  /** Optional cover image URL for blog-style platforms. */
  coverImageUrl?: string | null;
  /** dev.to / Hashnode "series" or "publication" hint. */
  series?: string | null;
  /**
   * Approved creative carried alongside the text body.
   *
   * - `null` / `undefined` → text-only publish (operator never
   *   attached an image; existing behavior).
   * - object → the scheduler verified an approved creative row
   *   exists and pre-validated that asset / alt text are present.
   *   Adapters that support media (Bluesky) must attach the image;
   *   adapters that don't may ignore the field. NEVER silently drop
   *   the image when this field is set.
   *
   * `creative_missing_asset` / `creative_missing_alt_text` reason
   * codes are produced by the scheduler before this field is built,
   * so the publisher can assume `creative !== null` is well-formed.
   */
  creative?: PublishCreative | null;
}

/**
 * Provider-agnostic creative payload. Adapters convert this into
 * platform-specific embeds (Bluesky: `app.bsky.embed.images`).
 *
 * The scheduler is responsible for picking the ONE approved
 * creative to attach. Multi-image attachments are deferred.
 */
export interface PublishCreative {
  /** weekly_plan_item_creatives.id (for audit / log metadata). */
  id: string;
  /** "image" | future: "video", etc. Today only image is wired. */
  creativeType: "image" | string;
  /** "uploaded" | "manual_url" | "generated" | ... */
  sourceType: string;
  /** Direct fetchable URL (Supabase storage or external CDN).
   *  Falls back to `sourceUrl` when null. */
  assetUrl: string | null;
  /** Optional fallback when assetUrl is null (e.g. manual_url
   *  creatives). The scheduler resolves to the effective URL
   *  before validation. */
  sourceUrl: string | null;
  /** Alt text. Required for Bluesky; the scheduler blocks the
   *  publish if missing rather than letting the publisher silently
   *  upload a no-alt image. */
  altText: string | null;
}

export interface PublishOutcome {
  status: PublishStatus;
  reasonCode: PublishReasonCode;
  reasonDetail: string | null;
  /** Returned by the platform on success: post id, permalink, etc. */
  externalId: string | null;
  externalUrl: string | null;
  /** Structured detail for logs (non-sensitive). */
  metadata: Record<string, unknown>;
}
