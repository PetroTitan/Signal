/**
 * Phase F2 — Reddit OAuth HTTP client.
 *
 * Thin wrapper around Reddit's OAuth 2.0 endpoints. All calls go
 * out over `fetch` and return discriminated unions so callers don't
 * have to try/catch the HTTP layer. No tokens are logged anywhere.
 *
 * Mandatory User-Agent format:
 *   <platform>:<app-id>:<version> (by /u/<username>)
 *
 * Reddit silently rate-limits or blocks generic user agents.
 */

import "server-only";
import type { OAuthProviderRuntimeConfig } from "./oauth-types";

const USER_AGENT =
  "web:com.webmasterid.signal:v0.1 (by /u/Webmasterid-core)";

export interface RedditTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export interface RedditMe {
  id: string;
  name: string;
  has_verified_email?: boolean;
  icon_img?: string;
}

export type RedditCallResult<T> =
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
        | "decode_error";
      detail: string;
    };

type RedditCallFailCode = Extract<
  RedditCallResult<unknown>,
  { ok: false }
>["code"];

function statusToCode(status: number): RedditCallFailCode {
  if (status === 401) return "oauth_expired";
  if (status === 403) return "oauth_insufficient_scope";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_5xx";
  return "provider_4xx";
}

/**
 * Exchange an authorization `code` for an access token. Uses HTTP
 * Basic auth with `client_id:client_secret`. Reddit returns the
 * standard OAuth 2.0 response shape.
 */
export async function exchangeCodeForToken(input: {
  runtime: OAuthProviderRuntimeConfig;
  code: string;
}): Promise<RedditCallResult<RedditTokenResponse>> {
  const basic = Buffer.from(
    `${input.runtime.clientId}:${input.runtime.clientSecret}`,
    "utf8",
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.runtime.redirectUri,
  }).toString();
  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      cache: "no-store",
    });
    return await parseTokenResponse(res);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshAccessToken(input: {
  runtime: OAuthProviderRuntimeConfig;
  refreshToken: string;
}): Promise<RedditCallResult<RedditTokenResponse>> {
  const basic = Buffer.from(
    `${input.runtime.clientId}:${input.runtime.clientSecret}`,
    "utf8",
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  }).toString();
  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      cache: "no-store",
    });
    return await parseTokenResponse(res);
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
 * Revoke a token. Reddit's revoke endpoint accepts either an access
 * or refresh token + `token_type_hint`. Best-effort — failures are
 * non-fatal; the local record still flips to revoked.
 */
export async function revokeToken(input: {
  runtime: OAuthProviderRuntimeConfig;
  token: string;
  tokenTypeHint: "access_token" | "refresh_token";
}): Promise<{ ok: boolean; httpStatus: number; detail: string | null }> {
  const basic = Buffer.from(
    `${input.runtime.clientId}:${input.runtime.clientSecret}`,
    "utf8",
  ).toString("base64");
  const body = new URLSearchParams({
    token: input.token,
    token_type_hint: input.tokenTypeHint,
  }).toString();
  try {
    const res = await fetch("https://www.reddit.com/api/v1/revoke_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      cache: "no-store",
    });
    // Reddit returns 204 on success and may return 200 with empty
    // body. We don't read the body — the status is the signal.
    return { ok: res.status >= 200 && res.status < 300, httpStatus: res.status, detail: null };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch the authenticated account's identity via /api/v1/me. Used
 * after a successful token exchange to record the Reddit username
 * and id, and used by the health check to confirm the token still
 * works.
 */
export async function fetchMe(input: {
  accessToken: string;
}): Promise<RedditCallResult<RedditMe>> {
  try {
    const res = await fetch("https://oauth.reddit.com/api/v1/me", {
      method: "GET",
      headers: {
        Authorization: `bearer ${input.accessToken}`,
        "User-Agent": USER_AGENT,
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
      const data = (await res.json()) as unknown;
      if (
        typeof data !== "object" ||
        data === null ||
        typeof (data as { name?: unknown }).name !== "string"
      ) {
        return {
          ok: false,
          httpStatus: res.status,
          code: "decode_error",
          detail: "Reddit /me response was malformed.",
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        data: data as RedditMe,
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

async function parseTokenResponse(
  res: Response,
): Promise<RedditCallResult<RedditTokenResponse>> {
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
    const data = (await res.json()) as Partial<RedditTokenResponse> & {
      error?: string;
    };
    if (typeof data.error === "string") {
      return {
        ok: false,
        httpStatus: res.status,
        code: "provider_4xx",
        detail: data.error,
      };
    }
    if (
      typeof data.access_token !== "string" ||
      typeof data.expires_in !== "number"
    ) {
      return {
        ok: false,
        httpStatus: res.status,
        code: "decode_error",
        detail: "Reddit token response was malformed.",
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
          typeof data.refresh_token === "string"
            ? data.refresh_token
            : undefined,
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
    // Cap to avoid huge bodies in logs / activity records.
    return text.slice(0, 400);
  } catch {
    return "";
  }
}
