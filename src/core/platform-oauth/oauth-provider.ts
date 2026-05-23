/**
 * Provider definitions for Reddit, X, and LinkedIn.
 *
 * Each entry describes:
 *   - authorize/token/revoke endpoints
 *   - whether PKCE is required
 *   - the *read-only* scopes Phase E3 will request
 *
 * No write scopes are listed. A future phase will extend each entry
 * with publishing scopes under a separate approval gate.
 */

import type { OAuthPlatform, OAuthProviderConfig, OAuthScope } from "./oauth-types";

const READ_PROFILE: OAuthScope = {
  scope: "identity",
  label: "Identity",
  required: true,
  rationale: "Confirm which account is connected and read its handle.",
  isPublishingScope: false,
};

export const OAUTH_PROVIDERS: Record<OAuthPlatform, OAuthProviderConfig> = {
  reddit: {
    platform: "reddit",
    label: "Reddit",
    // Reddit's OAuth 2.0 endpoints. The /authorize endpoint serves the
    // installed-app variant when `duration=temporary` is requested; we
    // ask for `duration=permanent` because we want refresh tokens.
    authorizeUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    pkce: false,
    revokeUrl: "https://www.reddit.com/api/v1/revoke_token",
    profileUrl: "https://oauth.reddit.com/api/v1/me",
    // Phase F2.5: identity + submit. `submit` enables the
    // controlled live-publish path; without it the publisher would
    // get 403 from Reddit even with a healthy token. `read`
    // (cadence checks) is still deferred.
    scopes: [
      { ...READ_PROFILE, scope: "identity" },
      {
        scope: "submit",
        label: "Submit posts",
        required: true,
        rationale:
          "Publish text + link posts under the controlled-publish workflow (SAFE_TEST_MODE).",
        isPublishingScope: true,
      },
    ],
  },
  x: {
    platform: "x",
    label: "X",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    pkce: true,
    revokeUrl: "https://api.twitter.com/2/oauth2/revoke",
    profileUrl: "https://api.twitter.com/2/users/me",
    scopes: [
      {
        scope: "users.read",
        label: "Read profile",
        required: true,
        rationale: "Confirm which account is connected and read its handle.",
        isPublishingScope: false,
      },
      {
        scope: "tweet.read",
        label: "Read posts",
        required: false,
        rationale: "Cadence checks against the account's own posts.",
        isPublishingScope: false,
      },
      {
        scope: "offline.access",
        label: "Offline access",
        required: true,
        rationale: "Required to receive a refresh token from X.",
        isPublishingScope: false,
      },
    ],
  },
  linkedin: {
    platform: "linkedin",
    label: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    pkce: true,
    revokeUrl: null,
    profileUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: [
      {
        scope: "openid",
        label: "OpenID",
        required: true,
        rationale: "OAuth 2.0 + OIDC handshake.",
        isPublishingScope: false,
      },
      {
        scope: "profile",
        label: "Read profile",
        required: true,
        rationale: "Identify which LinkedIn account is connected.",
        isPublishingScope: false,
      },
    ],
  },
};

export function getOAuthProvider(platform: OAuthPlatform): OAuthProviderConfig {
  return OAUTH_PROVIDERS[platform];
}

export function requiredScopes(platform: OAuthPlatform): string[] {
  return OAUTH_PROVIDERS[platform].scopes
    .filter((s) => s.required)
    .map((s) => s.scope);
}

export function allRequestedScopes(platform: OAuthPlatform): string[] {
  // Phase F2.5: read scopes always; publishing scopes only when
  // SAFE_TEST_MODE=true. This means a workspace that hasn't opted
  // into the controlled-publish flow never asks Reddit for `submit`.
  const safeTestOn =
    (process.env.SAFE_TEST_MODE ?? "").trim().toLowerCase() === "true";
  return OAUTH_PROVIDERS[platform].scopes
    .filter((s) => !s.isPublishingScope || safeTestOn)
    .map((s) => s.scope);
}
