/**
 * X (formerly Twitter) OAuth 2.0 HTTP client.
 *
 * Thin wrapper around the X OAuth 2.0 endpoints, parallel to
 * `reddit-client.ts`. All calls return discriminated unions; the HTTP
 * layer never throws, never logs tokens, and never logs the
 * `code_verifier`.
 *
 * Endpoints (official X API — https://developer.x.com/en/docs):
 *   - POST https://api.twitter.com/2/oauth2/token     (exchange + refresh)
 *   - POST https://api.twitter.com/2/oauth2/revoke    (revocation)
 *   - GET  https://api.twitter.com/2/users/me         (profile)
 *
 * Auth: confidential client. The runtime carries `clientId` +
 * `clientSecret`; we send Basic auth on token / revoke calls and a
 * Bearer header on `/users/me`. PKCE `code_verifier` is included in
 * the token exchange body as required by X for confidential clients.
 */

import "server-only";
import type { OAuthProviderRuntimeConfig } from "./oauth-types";

const X_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const X_REVOKE_URL = "https://api.twitter.com/2/oauth2/revoke";
const X_USERS_ME_URL = "https://api.twitter.com/2/users/me";

export interface XTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/**
 * X /2/users/me response. By default the API returns `id`, `name`,
 * and `username`. Signal treats `username` as the canonical handle
 * (mirrors what's shown as @-mention on the platform) and `id` as the
 * stable `provider_account_id`.
 */
export interface XUserMe {
  id: string;
  /** Display name. May contain spaces, emoji, etc. */
  name: string;
  /** @-handle (no leading @). Used for handle-mismatch verification. */
  username: string;
}

export type XCallResult<T> =
  | { ok: true; data: T; httpStatus: number }
  | {
      ok: false;
      httpStatus: number;
      code:
        | "oauth_expired"
        | "oauth_insufficient_scope"
        | "rate_limited"
        | "provider_4xx"
        | "provider_5xx"
        | "network_error"
        | "decode_error"
        | "invalid_grant";
      detail: string;
    };

type XCallFailCode = Extract<XCallResult<unknown>, { ok: false }>["code"];

function statusToCode(status: number): XCallFailCode {
  if (status === 401) return "oauth_expired";
  if (status === 403) return "oauth_insufficient_scope";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_5xx";
  return "provider_4xx";
}

function basicAuthHeader(runtime: OAuthProviderRuntimeConfig): string {
  const raw = `${runtime.clientId}:${runtime.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * Exchange an authorization `code` for tokens. X requires a Basic
 * auth header (confidential client) AND `code_verifier` in the body
 * (PKCE). `client_id` is included in the body for compatibility — X
 * accepts it both with and without and rejecting silently otherwise.
 *
 * Caller MUST supply `codeVerifier` (X requires PKCE on all auth-code
 * flows). The OAuth start route persists the verifier in
 * `oauth_state_tokens.code_verifier`; the callback reads it back.
 */
export async function exchangeXCode(input: {
  runtime: OAuthProviderRuntimeConfig;
  code: string;
  codeVerifier: string;
}): Promise<XCallResult<XTokenResponse>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.runtime.redirectUri,
    client_id: input.runtime.clientId,
    code_verifier: input.codeVerifier,
  }).toString();
  try {
    const res = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(input.runtime),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
    });
    return await parseXTokenResponse(res);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Refresh an access token. X rotates refresh tokens — the new
 * response carries a NEW `refresh_token` which MUST be persisted (the
 * old refresh token is invalidated by X on first use).
 *
 * On `invalid_grant` (refresh revoked or expired) the caller MUST
 * transition `connection_status` to `reauthorization_required` and
 * surface a clear reason code; we never silently downgrade.
 */
export async function refreshXAccessToken(input: {
  runtime: OAuthProviderRuntimeConfig;
  refreshToken: string;
}): Promise<XCallResult<XTokenResponse>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.runtime.clientId,
  }).toString();
  try {
    const res = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(input.runtime),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
    });
    return await parseXTokenResponse(res);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Revoke a token. Best-effort — failures are non-fatal; the local
 * record still transitions to revoked. The token is intentionally
 * NOT logged.
 */
export async function revokeXToken(input: {
  runtime: OAuthProviderRuntimeConfig;
  token: string;
  tokenTypeHint: "access_token" | "refresh_token";
}): Promise<{ ok: boolean; httpStatus: number; detail: string | null }> {
  const body = new URLSearchParams({
    token: input.token,
    token_type_hint: input.tokenTypeHint,
    client_id: input.runtime.clientId,
  }).toString();
  try {
    const res = await fetch(X_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(input.runtime),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      httpStatus: res.status,
      detail: null,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch the authenticated user's profile. X returns
 *   { data: { id, name, username } }
 * by default. We unwrap to the inner object so the callback's handle
 * comparison reads `data.username` directly.
 */
export async function fetchXMe(input: {
  accessToken: string;
}): Promise<XCallResult<XUserMe>> {
  try {
    const res = await fetch(X_USERS_ME_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await safeReadText(res);
      return {
        ok: false,
        httpStatus: res.status,
        code: statusToCode(res.status),
        detail,
      };
    }
    try {
      const raw = (await res.json()) as { data?: Partial<XUserMe> } | unknown;
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { data?: unknown }).data !== "object" ||
        (raw as { data?: unknown }).data === null
      ) {
        return {
          ok: false,
          httpStatus: res.status,
          code: "decode_error",
          detail: "X /users/me response was malformed.",
        };
      }
      const data = (raw as { data: Partial<XUserMe> }).data;
      if (
        typeof data.id !== "string" ||
        typeof data.name !== "string" ||
        typeof data.username !== "string"
      ) {
        return {
          ok: false,
          httpStatus: res.status,
          code: "decode_error",
          detail: "X /users/me response missing id/name/username.",
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        data: { id: data.id, name: data.name, username: data.username },
      };
    } catch (err) {
      return {
        ok: false,
        httpStatus: res.status,
        code: "decode_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function parseXTokenResponse(
  res: Response,
): Promise<XCallResult<XTokenResponse>> {
  if (!res.ok) {
    const detail = await safeReadText(res);
    // Try to surface `invalid_grant` distinctly. X's OAuth error body
    // is JSON: { error: "invalid_grant", error_description: "..." }
    let code: XCallFailCode = statusToCode(res.status);
    try {
      const parsed = JSON.parse(detail) as { error?: string };
      if (parsed.error === "invalid_grant") code = "invalid_grant";
    } catch {
      // not JSON — keep the status-derived code
    }
    return {
      ok: false,
      httpStatus: res.status,
      code,
      detail,
    };
  }
  try {
    const data = (await res.json()) as Partial<XTokenResponse> & {
      error?: string;
    };
    if (typeof data.error === "string") {
      const code: XCallFailCode =
        data.error === "invalid_grant" ? "invalid_grant" : "provider_4xx";
      return { ok: false, httpStatus: res.status, code, detail: data.error };
    }
    if (
      typeof data.access_token !== "string" ||
      typeof data.expires_in !== "number"
    ) {
      return {
        ok: false,
        httpStatus: res.status,
        code: "decode_error",
        detail: "X token response was malformed.",
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      data: {
        access_token: data.access_token,
        token_type: typeof data.token_type === "string" ? data.token_type : "bearer",
        expires_in: data.expires_in,
        scope: typeof data.scope === "string" ? data.scope : "",
        refresh_token:
          typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: res.status,
      code: "decode_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 400);
  } catch {
    return "";
  }
}
