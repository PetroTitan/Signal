import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeXCode,
  fetchXMe,
  refreshXAccessToken,
  revokeXToken,
} from "./x-client";
import type { OAuthProviderRuntimeConfig } from "./oauth-types";

/**
 * X OAuth 2.0 client unit tests.
 *
 * Mocks `globalThis.fetch`. No real network. Pins:
 *   - request shape (URL, headers, body)
 *   - response decoding for happy path
 *   - error mapping (4xx / 401 / 403 / 429 / 5xx / invalid_grant / decode)
 *   - secret hygiene: token and code_verifier never appear in the
 *     returned `data` or `detail` fields when the call fails
 */

const originalFetch = globalThis.fetch;
const RUNTIME: OAuthProviderRuntimeConfig = {
  clientId: "client_abc",
  clientSecret: "secret_xyz",
  redirectUri: "https://signal.example.com/api/oauth/x/callback",
};

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResp(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

const TOKEN_OK = {
  access_token: "atk_1",
  token_type: "bearer",
  expires_in: 7200,
  scope: "users.read tweet.read offline.access",
  refresh_token: "rtk_1",
};

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// exchangeXCode
// =====================================================================

describe("exchangeXCode", () => {
  it("POSTs to /2/oauth2/token with Basic auth, x-www-form-urlencoded body, and the PKCE verifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, TOKEN_OK));
    globalThis.fetch = fetchMock;

    const result = await exchangeXCode({
      runtime: RUNTIME,
      code: "auth-code-1",
      codeVerifier: "verifier-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(
      `Basic ${Buffer.from("client_abc:secret_xyz", "utf8").toString("base64")}`,
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code-1");
    expect(params.get("redirect_uri")).toBe(RUNTIME.redirectUri);
    expect(params.get("client_id")).toBe(RUNTIME.clientId);
    expect(params.get("code_verifier")).toBe("verifier-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.access_token).toBe("atk_1");
      expect(result.data.refresh_token).toBe("rtk_1");
      expect(result.data.expires_in).toBe(7200);
      expect(result.data.scope).toBe("users.read tweet.read offline.access");
    }
  });

  it("maps 400 invalid_grant to a distinct code", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResp(400, {
          error: "invalid_grant",
          error_description: "Authorization code expired.",
        }),
      );
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "stale",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_grant");
      expect(r.httpStatus).toBe(400);
    }
  });

  it("maps 401 to oauth_expired", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(401, "unauthorized"));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("oauth_expired");
  });

  it("maps 429 to rate_limited", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(429, ""));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rate_limited");
  });

  it("maps 5xx to provider_5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(502, "bad gateway"));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("provider_5xx");
  });

  it("maps network errors to network_error and surfaces no secret", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET"));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "verifier-secret-do-not-leak",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("network_error");
      expect(r.detail).not.toContain("verifier-secret-do-not-leak");
      expect(r.detail).not.toContain("secret_xyz");
    }
  });

  it("returns decode_error when body is not JSON", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 200 }));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_error");
  });

  it("returns decode_error when JSON is missing access_token", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(200, { token_type: "bearer", expires_in: 7200 }));
    const r = await exchangeXCode({
      runtime: RUNTIME,
      code: "c",
      codeVerifier: "v",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_error");
  });
});

// =====================================================================
// refreshXAccessToken
// =====================================================================

describe("refreshXAccessToken", () => {
  it("POSTs grant_type=refresh_token and persists the rotated refresh_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, {
        access_token: "atk_2",
        token_type: "bearer",
        expires_in: 7200,
        scope: "users.read offline.access",
        refresh_token: "rtk_2_rotated",
      }),
    );
    globalThis.fetch = fetchMock;
    const r = await refreshXAccessToken({
      runtime: RUNTIME,
      refreshToken: "rtk_1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.access_token).toBe("atk_2");
      expect(r.data.refresh_token).toBe("rtk_2_rotated");
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rtk_1");
    expect(params.get("client_id")).toBe(RUNTIME.clientId);
  });

  it("maps invalid_grant on refresh (token revoked)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResp(400, {
          error: "invalid_grant",
          error_description: "Refresh token revoked.",
        }),
      );
    const r = await refreshXAccessToken({
      runtime: RUNTIME,
      refreshToken: "rtk_revoked",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_grant");
  });

  it("never leaks the refresh token into error detail", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    const r = await refreshXAccessToken({
      runtime: RUNTIME,
      refreshToken: "rtk_super_secret_value",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).not.toContain("rtk_super_secret_value");
    }
  });
});

// =====================================================================
// revokeXToken
// =====================================================================

describe("revokeXToken", () => {
  it("POSTs token + token_type_hint and returns ok:true on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    globalThis.fetch = fetchMock;
    const r = await revokeXToken({
      runtime: RUNTIME,
      token: "atk_1",
      tokenTypeHint: "access_token",
    });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/oauth2/revoke");
    const params = new URLSearchParams(init.body as string);
    expect(params.get("token")).toBe("atk_1");
    expect(params.get("token_type_hint")).toBe("access_token");
    expect(params.get("client_id")).toBe(RUNTIME.clientId);
  });

  it("returns ok:false on a 4xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    const r = await revokeXToken({
      runtime: RUNTIME,
      token: "atk_1",
      tokenTypeHint: "access_token",
    });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(400);
  });

  it("never includes the token in the returned detail field", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("net error"));
    const r = await revokeXToken({
      runtime: RUNTIME,
      token: "super_secret_token_DO_NOT_LEAK",
      tokenTypeHint: "refresh_token",
    });
    expect(r.ok).toBe(false);
    expect(r.detail ?? "").not.toContain("super_secret_token_DO_NOT_LEAK");
  });
});

// =====================================================================
// fetchXMe
// =====================================================================

describe("fetchXMe", () => {
  it("GETs /2/users/me with Bearer auth and returns id + name + username", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, {
        data: { id: "1234567890", name: "Webmasterid", username: "webmasterid_core" },
      }),
    );
    globalThis.fetch = fetchMock;
    const r = await fetchXMe({ accessToken: "atk_1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe("1234567890");
      expect(r.data.name).toBe("Webmasterid");
      expect(r.data.username).toBe("webmasterid_core");
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/users/me");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer atk_1",
    );
  });

  it("maps 401 to oauth_expired", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(401, "unauthorized"));
    const r = await fetchXMe({ accessToken: "stale" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("oauth_expired");
  });

  it("maps 403 to oauth_insufficient_scope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(403, "forbidden"));
    const r = await fetchXMe({ accessToken: "limited" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("oauth_insufficient_scope");
  });

  it("returns decode_error when the data envelope is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResp(200, { other: "shape" }));
    const r = await fetchXMe({ accessToken: "atk" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_error");
  });

  it("returns decode_error when data.username is missing", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(200, { data: { id: "1", name: "x" } }));
    const r = await fetchXMe({ accessToken: "atk" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("decode_error");
  });

  it("does not include the access token in any returned field", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONN"));
    const r = await fetchXMe({ accessToken: "super_secret_token_DO_NOT_LEAK" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).not.toContain("super_secret_token_DO_NOT_LEAK");
    }
  });
});
