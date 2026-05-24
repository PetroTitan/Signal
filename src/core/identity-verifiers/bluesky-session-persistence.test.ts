import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBlueskySessionPlan } from "./bluesky-session-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { BlueskySessionResult } from "./bluesky-session";

// ---------------------------------------------------------------------
// Persistence tests require a token cipher. The real cipher reads
// TOKEN_ENCRYPTION_KEY from env. For these tests we set a fixed key
// and rely on the real AES-256-GCM path so encryption-shape
// assertions reflect production behaviour.
// ---------------------------------------------------------------------

const TEST_KEY =
  // 32 random bytes base64-encoded — matches the format the cipher
  // expects (see token-encryption.ts).
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  vi.resetModules();
});

const WS = "ws-1";
const ID = "id-1";

// =====================================================================
// Connected — happy path
// =====================================================================

describe("buildBlueskySessionPlan — connected", () => {
  const result: BlueskySessionResult = {
    outcome: "connected",
    providerAccountId: "did:plc:abc123",
    authenticatedHandle: "webmasterid.bsky.social",
    accessJwt: "eyJ.plaintext.access.jwt",
    refreshJwt: "eyJ.plaintext.refresh.jwt",
  };

  it("upsert targets the right workspace + identity + platform", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.workspaceId).toBe(WS);
    expect(plan.upsert!.accountId).toBe(ID);
    expect(plan.upsert!.platform).toBe("bluesky");
  });

  it("stores DID as provider_account_id, canonical handle as handle", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.providerAccountId).toBe("did:plc:abc123");
    expect(plan.upsert!.handle).toBe("webmasterid.bsky.social");
  });

  it("encrypts access + refresh JWTs (envelopes are NOT the plaintext)", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    const access = plan.upsert!.accessTokenEncrypted!;
    const refresh = plan.upsert!.refreshTokenEncrypted!;
    expect(access).not.toBe("eyJ.plaintext.access.jwt");
    expect(refresh).not.toBe("eyJ.plaintext.refresh.jwt");
    expect(access).not.toContain("eyJ.plaintext.access.jwt");
    expect(refresh).not.toContain("eyJ.plaintext.refresh.jwt");
    // Sanity: envelope is non-empty.
    expect(access.length).toBeGreaterThan(0);
    expect(refresh.length).toBeGreaterThan(0);
  });

  it("stores connection_status='connected'", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.connectionStatus).toBe("connected");
  });

  it("response is 200 OK with DID + handle — NEVER JWTs or password", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.response.status).toBe(200);
    const body = plan.response.body;
    expect(body.ok).toBe(true);
    expect(body.authenticated_handle).toBe("webmasterid.bsky.social");
    expect(body.provider_account_id).toBe("did:plc:abc123");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("eyJ.plaintext.access.jwt");
    expect(serialized).not.toContain("eyJ.plaintext.refresh.jwt");
    expect(serialized.toLowerCase()).not.toContain("password");
    expect(serialized.toLowerCase()).not.toContain("jwt");
  });

  it("metadata stores diagnostic info only (no tokens, no password, no Authorization header)", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(
      ["last_message", "token_storage", "verification_method"].sort(),
    );
    const serialized = JSON.stringify(meta).toLowerCase();
    expect(serialized).not.toContain("eyj"); // JWT base64 prefix
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("bearer");
  });

  it("promotes growth_accounts.connection_status to 'connected'", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.promoteGrowthAccount).toBe(true);
  });

  it("the upserted row, fed into resolveIdentityPublishState, resolves to 'connected'", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const connection: IdentityConnection = {
      authStatus: narrowConnectionAuthStatus(plan.upsert!.connectionStatus),
      platform: plan.upsert!.platform,
      workspaceId: plan.upsert!.workspaceId,
      authenticatedHandle: plan.upsert!.handle,
      providerAccountId: plan.upsert!.providerAccountId,
      handleMismatchObserved: meta.handle_mismatch != null,
    };
    const verdict = resolveIdentityPublishState({
      identity: {
        platform: "bluesky",
        workspaceId: WS,
        declaredHandle: "webmasterid.bsky.social",
        disabled: false,
        lifecycleStatus: "active",
      },
      platform: { publishingMode: "api" },
      workspace: { configured: true },
      connection,
    });
    expect(verdict).toBe("connected");
  });
});

// =====================================================================
// Mismatch — credentials work but for a different DID
// =====================================================================

describe("buildBlueskySessionPlan — mismatched", () => {
  const result: BlueskySessionResult = {
    outcome: "mismatched",
    declaredHandle: "webmasterid.bsky.social",
    authenticatedHandle: "someoneelse.bsky.social",
    providerAccountId: "did:plc:xyz",
  };

  it("writes audit row with connection_status='error' and handle_mismatch metadata", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.connectionStatus).toBe("error");
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.handle_mismatch).toEqual(
      expect.objectContaining({
        declared: "webmasterid.bsky.social",
        authenticated: "someoneelse.bsky.social",
      }),
    );
  });

  it("does NOT persist any token (encrypted columns must be null)", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("does NOT promote growth_accounts", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.promoteGrowthAccount).toBe(false);
  });

  it("response is 409 with declared + authenticated handles", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.response.status).toBe(409);
    expect(plan.response.body.code).toBe("handle_mismatch");
    expect(plan.response.body.declared).toBe("webmasterid.bsky.social");
    expect(plan.response.body.authenticated).toBe("someoneelse.bsky.social");
  });

  it("the upserted row, fed into resolveIdentityPublishState, resolves to 'mismatched'", () => {
    const plan = buildBlueskySessionPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const connection: IdentityConnection = {
      authStatus: narrowConnectionAuthStatus(plan.upsert!.connectionStatus),
      platform: plan.upsert!.platform,
      workspaceId: plan.upsert!.workspaceId,
      authenticatedHandle: plan.upsert!.handle,
      providerAccountId: plan.upsert!.providerAccountId,
      handleMismatchObserved: meta.handle_mismatch != null,
    };
    const verdict = resolveIdentityPublishState({
      identity: {
        platform: "bluesky",
        workspaceId: WS,
        declaredHandle: "webmasterid.bsky.social",
        disabled: false,
        lifecycleStatus: "active",
      },
      platform: { publishingMode: "api" },
      workspace: { configured: true },
      connection,
    });
    expect(verdict).toBe("mismatched");
  });
});

// =====================================================================
// Error outcomes — no row written, no growth_account promotion
// =====================================================================

describe("buildBlueskySessionPlan — error outcomes", () => {
  it("auth_failed → 401, no upsert, no promote", () => {
    const plan = buildBlueskySessionPlan({
      result: {
        outcome: "error",
        code: "auth_failed",
        message: "Bluesky rejected.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(401);
    expect(plan.response.body.code).toBe("auth_failed");
  });

  it("credentials_missing → 400, no upsert", () => {
    const plan = buildBlueskySessionPlan({
      result: {
        outcome: "error",
        code: "credentials_missing",
        message: "App Password required.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("handle_invalid → 400, no upsert", () => {
    const plan = buildBlueskySessionPlan({
      result: {
        outcome: "error",
        code: "handle_invalid",
        message: "Bad handle.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: null,
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("network_error → 503, no upsert", () => {
    const plan = buildBlueskySessionPlan({
      result: {
        outcome: "error",
        code: "network_error",
        message: "Down.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
  });
});

// =====================================================================
// Token-storage refusal — when TOKEN_ENCRYPTION_KEY is missing
// =====================================================================

describe("buildBlueskySessionPlan — token storage refusal", () => {
  async function buildWithEnv(envValue: string | undefined) {
    if (envValue === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = envValue;
    vi.resetModules();
    const { buildBlueskySessionPlan: buildFresh } = await import(
      "./bluesky-session-persistence"
    );
    return buildFresh({
      result: {
        outcome: "connected",
        providerAccountId: "did:plc:abc",
        authenticatedHandle: "webmasterid.bsky.social",
        accessJwt: "secret-access-jwt-value",
        refreshJwt: "secret-refresh-jwt-value",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
  }

  it("missing TOKEN_ENCRYPTION_KEY: returns 503, no upsert, no growth promote", async () => {
    const plan = await buildWithEnv(undefined);
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(503);
    expect(plan.response.body.code).toBe("token_storage_unavailable");
  });

  it("malformed TOKEN_ENCRYPTION_KEY (wrong length): same 503 + no persistence", async () => {
    // 16 random base64 chars decode to 12 bytes — not 32. The
    // cipher's self-test rejects this and the persistence helper
    // refuses to persist.
    const plan = await buildWithEnv("dGhpcyBpcyB0b28gc2hvcnQ=");
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(503);
    expect(plan.response.body.code).toBe("token_storage_unavailable");
  });

  it("malformed TOKEN_ENCRYPTION_KEY (gibberish): same 503 + no persistence", async () => {
    const plan = await buildWithEnv("not-a-valid-base64-key-at-all-!!!");
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
    expect(plan.response.body.code).toBe("token_storage_unavailable");
  });

  it("valid TOKEN_ENCRYPTION_KEY (32 bytes base64): persists with encrypted tokens", async () => {
    // 32 bytes of base64 = 44 chars including padding. This is the
    // shape `openssl rand -base64 32` produces.
    const plan = await buildWithEnv(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    );
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.connectionStatus).toBe("connected");
    expect(plan.upsert!.accessTokenEncrypted).not.toBeNull();
    expect(plan.upsert!.accessTokenEncrypted).not.toContain(
      "secret-access-jwt-value",
    );
    expect(plan.response.status).toBe(200);
  });

  it("error response NEVER includes the access JWT, the refresh JWT, the key value, or a stack trace", async () => {
    const plan = await buildWithEnv(undefined);
    const serialized = JSON.stringify(plan.response.body);
    expect(serialized).not.toContain("secret-access-jwt-value");
    expect(serialized).not.toContain("secret-refresh-jwt-value");
    // The env-var NAME may appear (it's a diagnostic hint for the
    // operator). Actual key VALUES would never have a shape like
    // "TOKEN_ENCRYPTION_KEY", but pin the absence of stack-trace
    // hallmarks anyway.
    expect(serialized).not.toContain("at Object.");
    expect(serialized).not.toContain("\\n    at ");
  });

  it("operator-facing message names the env-var symptom + the fix path", async () => {
    const plan = await buildWithEnv(undefined);
    const message = String(plan.response.body.message ?? "");
    expect(message.toLowerCase()).toContain(
      "server session encryption",
    );
    expect(message).toContain("TOKEN_ENCRYPTION_KEY");
    expect(message.toLowerCase()).toContain("administrator");
    expect(message.toLowerCase()).toContain("redeploy");
  });
});
