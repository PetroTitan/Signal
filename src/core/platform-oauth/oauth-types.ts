/**
 * Phase E3 — OAuth connection types.
 *
 * The vocabulary mirrors the CHECK constraints in
 *   supabase/migrations/20260522060001_phase_e3_platform_connections.sql
 *
 * `OAuthPlatform` only covers the three social publishing surfaces
 * we model OAuth for: Reddit, X, LinkedIn. Google search-console
 * lives in its own discoverability surface and never appears here.
 */

import type {
  OAuthPlatform,
  PlatformConnectionConnectionStatus,
  PlatformConnectionHealthStatus,
} from "@/lib/supabase/types";

export type { OAuthPlatform, PlatformConnectionConnectionStatus, PlatformConnectionHealthStatus };

export const OAUTH_PLATFORMS = ["reddit", "x", "linkedin"] as const satisfies ReadonlyArray<OAuthPlatform>;

export const OAUTH_PLATFORM_LABELS: Record<OAuthPlatform, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
};

export const PLATFORM_CONNECTION_STATUS_LABELS: Record<
  PlatformConnectionConnectionStatus,
  string
> = {
  not_connected: "Not connected",
  connected: "Connected",
  expired: "Token expired",
  revoked: "Revoked",
  error: "Error",
  disabled: "Disabled",
  reauthorization_required: "Reauthorization required",
};

export const PLATFORM_CONNECTION_HEALTH_LABELS: Record<
  PlatformConnectionHealthStatus,
  string
> = {
  healthy: "Healthy",
  degraded: "Degraded",
  expired: "Expired",
  revoked: "Revoked",
  unknown: "Unknown",
};

/**
 * Domain shape — the repository layer strips the encrypted-token
 * columns before returning. The client never sees a token.
 */
export interface PlatformConnection {
  id: string;
  workspaceId: string;
  accountId: string | null;
  platform: OAuthPlatform;
  providerAccountId: string | null;
  handle: string | null;
  displayName: string | null;
  connectionStatus: PlatformConnectionConnectionStatus;
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string | null;
  revokedAt: string | null;
  lastCheckedAt: string | null;
  healthStatus: PlatformConnectionHealthStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /**
   * True when an encrypted token is *stored*. The literal value is
   * never exposed. Useful for the UI to say "token present" without
   * leaking anything.
   */
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

export interface OAuthScope {
  scope: string;
  label: string;
  required: boolean;
  rationale: string;
  /** True if this scope unlocks any kind of write — disabled in this
   *  phase. */
  isPublishingScope: boolean;
}

export interface OAuthProviderConfig {
  platform: OAuthPlatform;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Whether the provider requires PKCE (S256). */
  pkce: boolean;
  /** Whether the provider needs a separate revocation endpoint call
   *  on disconnect (best-effort, not all providers honor it). */
  revokeUrl: string | null;
  scopes: OAuthScope[];
  /** Resource URL used by /health to verify the token still works.
   *  Phase E3 only documents this — no live call is made yet. */
  profileUrl: string;
}

export interface OAuthProviderRuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthStartResult {
  authorizeUrl: string;
  state: string;
}

export interface OAuthCallbackResult {
  connection: PlatformConnection;
  redirectAfter: string | null;
}
