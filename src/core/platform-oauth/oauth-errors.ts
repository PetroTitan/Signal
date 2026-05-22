/**
 * Typed errors for the OAuth layer. The HTTP routes catch these and
 * translate them into JSON responses with safe messages — they never
 * leak provider error bodies or stack traces back to the client.
 */

export type OAuthErrorCode =
  | "platform_unsupported"
  | "provider_not_configured"
  | "not_authenticated"
  | "no_workspace"
  | "state_missing"
  | "state_mismatch"
  | "state_expired"
  | "provider_denied"
  | "provider_error"
  | "token_storage_unavailable"
  | "unknown";

export class OAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export const OAUTH_ERROR_MESSAGES: Record<OAuthErrorCode, string> = {
  platform_unsupported: "This platform is not supported for OAuth.",
  provider_not_configured: "OAuth app not configured yet.",
  not_authenticated: "You must be signed in to connect a platform.",
  no_workspace: "No workspace selected.",
  state_missing: "The OAuth state parameter is missing.",
  state_mismatch: "The OAuth state did not match — possible CSRF.",
  state_expired: "The OAuth state expired before the callback returned.",
  provider_denied: "You denied the authorization request.",
  provider_error: "The platform returned an error during authorization.",
  token_storage_unavailable:
    "Token encryption is not configured. Connection prepared without storing real tokens.",
  unknown: "Something went wrong during OAuth.",
};

export function isOAuthError(err: unknown): err is OAuthError {
  return err instanceof OAuthError;
}
