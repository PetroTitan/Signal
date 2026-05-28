import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFreshXAccessToken } from "./x-token-refresh";

/**
 * X token-refresh helper unit tests.
 *
 * Mocks the Supabase client + `globalThis.fetch` (used by the X
 * client under the hood). Pins:
 *   - no-refresh-needed paths (no refresh token, no expiry, far in
 *     the future)
 *   - refreshed path (rotated refresh + access tokens persisted)
 *   - invalid_grant path → connection_status='reauthorization_required',
 *     encrypted blobs cleared
 *   - transient error paths (network, 5xx) → original token preserved,
 *     no DB write
 *   - secret hygiene: plaintext tokens never appear in returned values
 */

const originalFetch = globalThis.fetch;

const ENV = {
  X_CLIENT_ID: "client_abc",
  X_CLIENT_SECRET: "secret_xyz",
  X_REDIRECT_URI: "https://signal.example.com/api/oauth/x/callback",
  TOKEN_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
};

function setEnv() {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface UpdateCapture {
  patch: Record<string, unknown> | null;
  workspaceId: string | null;
  connectionId: string | null;
}

function makeDbMock(): { db: any; capture: UpdateCapture } {
  const capture: UpdateCapture = {
    patch: null,
    workspaceId: null,
    connectionId: null,
  };
  const eq2 = vi.fn().mockResolvedValue({ error: null });
  const eq1 = vi.fn().mockReturnValue({
    eq: (col: string, val: string) => {
      capture.connectionId = val;
      return eq2();
    },
  });
  const update = vi.fn().mockImplementation((patch: Record<string, unknown>) => {
    capture.patch = patch;
    return {
      eq: (col: string, val: string) => {
        capture.workspaceId = val;
        return eq1(col, val);
      },
    };
  });
  const db = {
    from: vi.fn().mockReturnValue({ update }),
  };
  return { db, capture };
}

// Encrypts a plaintext using the real cipher so the helper's decrypt
// step works end-to-end.
async function encrypt(plaintext: string): Promise<string> {
  const { getTokenCipher } = await import("./token-encryption");
  const cipher = getTokenCipher();
  const enc = cipher.encrypt(plaintext);
  if (!enc) throw new Error("encrypt returned null");
  return enc;
}

beforeEach(() => {
  setEnv();
  globalThis.fetch = vi.fn();
  // Reset cached cipher between tests so env mutations take effect.
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// no_refresh_needed paths
// =====================================================================

describe("ensureFreshXAccessToken — no_refresh_needed paths", () => {
  it("returns no_refresh_needed when refresh_token_encrypted is null", async () => {
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access",
      currentRefreshTokenEncrypted: null,
      currentExpiresAt: "2026-01-01T00:00:00Z",
      nowIso: "2027-01-01T00:00:00Z",
    });
    expect(r.outcome).toEqual({ kind: "no_refresh_needed" });
    expect(r.accessTokenEncrypted).toBe("enc-access");
    expect(capture.patch).toBeNull();
  });

  it("returns no_refresh_needed when expires_at is null (don't preemptively refresh)", async () => {
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access",
      currentRefreshTokenEncrypted: "enc-refresh",
      currentExpiresAt: null,
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome).toEqual({ kind: "no_refresh_needed" });
    expect(capture.patch).toBeNull();
  });

  it("returns no_refresh_needed when expires_at is comfortably in the future", async () => {
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access",
      currentRefreshTokenEncrypted: "enc-refresh",
      currentExpiresAt: "2026-05-28T01:00:00Z",
      nowIso: "2026-05-28T00:00:00Z",
      refreshBufferSeconds: 60,
    });
    expect(r.outcome).toEqual({ kind: "no_refresh_needed" });
    expect(capture.patch).toBeNull();
  });
});

// =====================================================================
// refreshed path
// =====================================================================

describe("ensureFreshXAccessToken — refreshed path", () => {
  it("calls /2/oauth2/token with grant_type=refresh_token, persists rotated tokens, returns refreshed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(200, {
        access_token: "atk_new",
        token_type: "bearer",
        expires_in: 7200,
        scope: "users.read offline.access tweet.write",
        refresh_token: "rtk_rotated",
      }),
    );
    globalThis.fetch = fetchMock;
    const refreshEnc = await encrypt("rtk_original");
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z", // 30s until expiry
      nowIso: "2026-05-28T00:00:00Z",
      refreshBufferSeconds: 60,
    });
    expect(r.outcome).toEqual({ kind: "refreshed" });
    // Returned encrypted blob is the new one — distinct from the old.
    expect(r.accessTokenEncrypted).toBeTruthy();
    expect(r.accessTokenEncrypted).not.toBe("enc-access-old");
    // No plaintext leaks in the returned value.
    expect(r.accessTokenEncrypted).not.toContain("atk_new");
    expect(r.accessTokenEncrypted).not.toContain("rtk_rotated");

    // DB write captured.
    expect(capture.patch).not.toBeNull();
    const patch = capture.patch as Record<string, unknown>;
    expect(patch.connection_status).toBe("connected");
    expect(patch.health_status).toBe("healthy");
    expect(typeof patch.access_token_encrypted).toBe("string");
    expect(typeof patch.refresh_token_encrypted).toBe("string");
    expect(typeof patch.expires_at).toBe("string");
    // Persisted refresh blob is the encrypted version of the rotated
    // token — never the plaintext.
    expect(patch.refresh_token_encrypted).not.toBe("rtk_rotated");

    // Fetch shape sanity.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rtk_original");
  });

  it("leaves refresh_token_encrypted untouched when X doesn't return a new one", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResp(200, {
        access_token: "atk_new",
        token_type: "bearer",
        expires_in: 7200,
        scope: "users.read",
        // no refresh_token returned
      }),
    );
    const refreshEnc = await encrypt("rtk_original");
    const { db, capture } = makeDbMock();
    await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    const patch = capture.patch as Record<string, unknown>;
    expect(patch.access_token_encrypted).toBeTruthy();
    // refresh_token_encrypted is NOT in the patch when the server
    // didn't rotate it — we leave the existing blob in place.
    expect("refresh_token_encrypted" in patch).toBe(false);
  });
});

// =====================================================================
// reauthorization_required path
// =====================================================================

describe("ensureFreshXAccessToken — reauthorization_required path", () => {
  it("on invalid_grant: clears encrypted blobs and sets connection_status='reauthorization_required'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResp(400, {
        error: "invalid_grant",
        error_description: "Refresh token revoked.",
      }),
    );
    const refreshEnc = await encrypt("rtk_revoked");
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome.kind).toBe("reauthorization_required");
    expect(r.accessTokenEncrypted).toBeNull();

    const patch = capture.patch as Record<string, unknown>;
    expect(patch.connection_status).toBe("reauthorization_required");
    expect(patch.access_token_encrypted).toBeNull();
    expect(patch.refresh_token_encrypted).toBeNull();
    expect((patch.metadata as Record<string, unknown>).last_message).toContain(
      "invalid_grant",
    );
  });

  it("on 401: maps to reauthorization_required (token expired beyond refresh window)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const refreshEnc = await encrypt("rtk_expired");
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome.kind).toBe("reauthorization_required");
    const patch = capture.patch as Record<string, unknown>;
    expect(patch.connection_status).toBe("reauthorization_required");
  });
});

// =====================================================================
// transient_error path
// =====================================================================

describe("ensureFreshXAccessToken — transient_error path", () => {
  it("on network error: returns transient_error and preserves the original encrypted access token", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET"));
    const refreshEnc = await encrypt("rtk_original");
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome.kind).toBe("transient_error");
    if (r.outcome.kind === "transient_error") {
      expect(r.outcome.reason).toBe("network_error");
    }
    expect(r.accessTokenEncrypted).toBe("enc-access-old");
    // No DB write on transient error.
    expect(capture.patch).toBeNull();
  });

  it("on 5xx: returns transient_error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("server down", { status: 503 }));
    const refreshEnc = await encrypt("rtk_original");
    const { db, capture } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome.kind).toBe("transient_error");
    if (r.outcome.kind === "transient_error") {
      expect(r.outcome.reason).toBe("provider_5xx");
    }
    expect(r.accessTokenEncrypted).toBe("enc-access-old");
    expect(capture.patch).toBeNull();
  });

  it("when runtime env is missing: returns transient_error without calling fetch", async () => {
    delete process.env.X_CLIENT_ID;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const refreshEnc = await encrypt("rtk_original");
    const { db } = makeDbMock();
    const r = await ensureFreshXAccessToken({
      db,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      currentAccessTokenEncrypted: "enc-access-old",
      currentRefreshTokenEncrypted: refreshEnc,
      currentExpiresAt: "2026-05-28T00:00:30Z",
      nowIso: "2026-05-28T00:00:00Z",
    });
    expect(r.outcome.kind).toBe("transient_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
