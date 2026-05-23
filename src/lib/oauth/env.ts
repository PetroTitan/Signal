import "server-only";
import type { OAuthPlatform, OAuthProviderRuntimeConfig } from "@/core/platform-oauth";

function clean(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Reads the OAuth runtime config for a platform from server env.
 * Returns null when any required field is missing — callers surface
 * the "OAuth app not configured yet." message in that case.
 */
export function readOAuthProviderRuntime(
  platform: OAuthPlatform,
): OAuthProviderRuntimeConfig | null {
  const prefix = platform === "x" ? "X" : platform.toUpperCase();
  const clientId = clean(process.env[`${prefix}_CLIENT_ID`]);
  const clientSecret = clean(process.env[`${prefix}_CLIENT_SECRET`]);
  const redirectUri = clean(process.env[`${prefix}_REDIRECT_URI`]);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isOAuthProviderConfigured(platform: OAuthPlatform): boolean {
  return readOAuthProviderRuntime(platform) !== null;
}

export function hasTokenEncryptionKey(): boolean {
  return clean(process.env.TOKEN_ENCRYPTION_KEY) !== null;
}

/**
 * Phase F2.5 (post-blocker) — Reddit API approval status.
 *
 * Reddit's Responsible Builder Policy gates client-id provisioning,
 * which means we cannot complete OAuth even when env vars are set.
 * Set `REDDIT_OAUTH_STATUS=blocked_pending_reddit_api_approval` to
 * surface the block to the operator and route /execution/items/<id>
 * to the manual-publish fallback.
 *
 * Values:
 *   - "enabled" (default when unset)
 *   - "blocked_pending_reddit_api_approval"
 */
export type RedditOauthStatus =
  | "enabled"
  | "blocked_pending_reddit_api_approval";

export function readRedditOauthStatus(): RedditOauthStatus {
  const raw = clean(process.env.REDDIT_OAUTH_STATUS)?.toLowerCase() ?? null;
  if (raw === "blocked_pending_reddit_api_approval") return raw;
  return "enabled";
}

export function isRedditOauthBlocked(): boolean {
  return readRedditOauthStatus() === "blocked_pending_reddit_api_approval";
}
