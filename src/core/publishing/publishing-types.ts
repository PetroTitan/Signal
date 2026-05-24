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
