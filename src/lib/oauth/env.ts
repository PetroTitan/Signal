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
