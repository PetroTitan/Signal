/**
 * The OAuth policy boundary. These are the rules the OAuth layer
 * enforces unconditionally — they are *not* configurable by the
 * operator.
 */

export const OAUTH_POLICY_NEVER = [
  "Ask the user for their platform password.",
  "Ask the user for a cookie, session token, or 2FA code.",
  "Ask the user for a recovery code or browser profile.",
  "Use browser-automation to log into a platform.",
  "Use anti-detect fingerprints or proxy rotation.",
  "Store any of the above in the database, logs, or activity stream.",
  "Bypass the official OAuth flow for any reason.",
] as const;

export const OAUTH_POLICY_ALWAYS = [
  "Use the platform's official OAuth endpoint as published in its developer docs.",
  "Use a fresh `state` parameter on every authorization request and verify it on callback.",
  "Bind the state to the authenticated user + workspace so it cannot be replayed across sessions.",
  "Use PKCE (S256) when the provider supports it (X 2.0, Reddit installed-app variant, LinkedIn).",
  "Reject the connection if the platform returns an error or if scopes are missing required entries.",
  "Persist only encrypted tokens in `platform_connections.access_token_encrypted`. Refuse to store plaintext.",
  "Project encrypted-token columns away before returning a connection to the client.",
  "Write an `activity_events` row for every connection lifecycle event.",
] as const;

export const OAUTH_POLICY_REQUIRES_APPROVAL = [
  "Adding a new provider to the supported list.",
  "Granting a publishing scope (submit, tweet.write, w_member_social).",
  "Storing real tokens — requires the encryption layer to be live.",
  "Calling any provider write endpoint.",
] as const;

/**
 * Phase E3 is intentionally inert: this phase models the boundary,
 * the routes, and the storage. It does not enable publishing, and it
 * does not store real tokens unless the encryption layer is live.
 */
export const OAUTH_PHASE_E3_LIMITS = [
  "No external publishing.",
  "No write scopes are requested.",
  "No background jobs.",
  "No automatic token refresh.",
  "Connection health checks are manual-only (operator clicks 'Check connection').",
] as const;
