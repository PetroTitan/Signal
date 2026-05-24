import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDevtoVerifyPlan } from "./devto-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { DevtoVerifierResult } from "./devto";

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

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
// connected — happy path with real AES encryption
// =====================================================================

describe("buildDevtoVerifyPlan — connected", () => {
  const result: DevtoVerifierResult = {
    outcome: "connected",
    providerAccountId: "123456",
    authenticatedHandle: "petro_hrys_aea7ce9ab5df8d",
    apiKey: "PLAINTEXT-DEVTO-API-KEY",
  };

  it("upsert targets the right workspace + identity + platform", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.workspaceId).toBe(WS);
    expect(plan.upsert!.accountId).toBe(ID);
    expect(plan.upsert!.platform).toBe("devto");
  });

  it("stores dev.to id as provider_account_id, canonical username as handle", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert!.providerAccountId).toBe("123456");
    expect(plan.upsert!.handle).toBe("petro_hrys_aea7ce9ab5df8d");
  });

  it("encrypts the API key (envelope is NOT the plaintext)", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    const access = plan.upsert!.accessTokenEncrypted!;
    expect(access).not.toBe("PLAINTEXT-DEVTO-API-KEY");
    expect(access).not.toContain("PLAINTEXT-DEVTO-API-KEY");
    expect(access.length).toBeGreaterThan(0);
    // dev.to has no refresh token.
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("stores connection_status='connected'", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert!.connectionStatus).toBe("connected");
  });

  it("response is 200 with username + id — NEVER the API key", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.response.status).toBe(200);
    const body = plan.response.body;
    expect(body.ok).toBe(true);
    expect(body.authenticated_handle).toBe("petro_hrys_aea7ce9ab5df8d");
    expect(body.provider_account_id).toBe("123456");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PLAINTEXT-DEVTO-API-KEY");
    expect(serialized.toLowerCase()).not.toContain("api_key");
    expect(serialized.toLowerCase()).not.toContain("api-key");
  });

  it("metadata stores diagnostic info only (no API key, no Authorization)", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(
      ["last_message", "token_storage", "verification_method"].sort(),
    );
    const serialized = JSON.stringify(meta).toLowerCase();
    expect(serialized).not.toContain("plaintext-devto-api-key");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("bearer");
  });

  it("promotes growth_accounts.connection_status to 'connected'", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.promoteGrowthAccount).toBe(true);
  });

  it("the upserted row resolves to 'connected' via resolveIdentityPublishState", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
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
        platform: "devto",
        workspaceId: WS,
        declaredHandle: "petro_hrys_aea7ce9ab5df8d",
        disabled: false,
        lifecycleStatus: "active",
      },
      platform: { publishingMode: "api" },
      workspace: null, // dev.to has no workspace-level integration
      connection,
    });
    expect(verdict).toBe("connected");
  });
});

// =====================================================================
// mismatched
// =====================================================================

describe("buildDevtoVerifyPlan — mismatched", () => {
  const result: DevtoVerifierResult = {
    outcome: "mismatched",
    declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    authenticatedHandle: "someoneelse",
    providerAccountId: "999",
  };

  it("writes audit row with connection_status='error' and handle_mismatch metadata", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert!.connectionStatus).toBe("error");
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.handle_mismatch).toEqual(
      expect.objectContaining({
        declared: "petro_hrys_aea7ce9ab5df8d",
        authenticated: "someoneelse",
      }),
    );
  });

  it("does NOT persist the API key on mismatch (encrypted column is null)", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("does NOT promote growth_accounts on mismatch", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.promoteGrowthAccount).toBe(false);
  });

  it("response is 409 with declared + authenticated handles", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.response.status).toBe(409);
    expect(plan.response.body.code).toBe("handle_mismatch");
    expect(plan.response.body.declared).toBe("petro_hrys_aea7ce9ab5df8d");
    expect(plan.response.body.authenticated).toBe("someoneelse");
  });

  it("upserted row resolves to 'mismatched' via resolveIdentityPublishState", () => {
    const plan = buildDevtoVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
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
        platform: "devto",
        workspaceId: WS,
        declaredHandle: "petro_hrys_aea7ce9ab5df8d",
        disabled: false,
        lifecycleStatus: "active",
      },
      platform: { publishingMode: "api" },
      workspace: null,
      connection,
    });
    expect(verdict).toBe("mismatched");
  });
});

// =====================================================================
// error outcomes
// =====================================================================

describe("buildDevtoVerifyPlan — error outcomes", () => {
  it("auth_failed → 401, no upsert, no promote", () => {
    const plan = buildDevtoVerifyPlan({
      result: {
        outcome: "error",
        code: "auth_failed",
        message: "dev.to rejected.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(401);
  });

  it("credentials_missing → 400, no upsert", () => {
    const plan = buildDevtoVerifyPlan({
      result: {
        outcome: "error",
        code: "credentials_missing",
        message: "Need a key.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("handle_invalid → 400, no upsert", () => {
    const plan = buildDevtoVerifyPlan({
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
    const plan = buildDevtoVerifyPlan({
      result: {
        outcome: "error",
        code: "network_error",
        message: "Down.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
  });

  it("provider_error → 502, no upsert", () => {
    const plan = buildDevtoVerifyPlan({
      result: {
        outcome: "error",
        code: "provider_error",
        message: "500.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(502);
  });
});

// =====================================================================
// token storage refusal — TOKEN_ENCRYPTION_KEY missing
// =====================================================================

describe("buildDevtoVerifyPlan — token storage refusal", () => {
  it("returns 503 token_storage_unavailable when the cipher refuses; no upsert", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    vi.resetModules();
    const { buildDevtoVerifyPlan: buildFresh } = await import(
      "./devto-persistence"
    );
    const plan = buildFresh({
      result: {
        outcome: "connected",
        providerAccountId: "1",
        authenticatedHandle: "petro_hrys_aea7ce9ab5df8d",
        apiKey: "PLAINTEXT-DEVTO-KEY",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "petro_hrys_aea7ce9ab5df8d",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(503);
    expect(plan.response.body.code).toBe("token_storage_unavailable");
    // The error message must use the standard operator-facing copy.
    expect(String(plan.response.body.message ?? "").toLowerCase()).toContain(
      "server session encryption",
    );
  });
});

// =====================================================================
// safety — no key leak across outcomes
// =====================================================================

describe("buildDevtoVerifyPlan — safety", () => {
  it("no outcome introduces the API key value into the upsert plan", () => {
    const outcomes: DevtoVerifierResult[] = [
      {
        outcome: "connected",
        providerAccountId: "1",
        authenticatedHandle: "x",
        apiKey: "LEAK-PROBE-DEVTO-KEY",
      },
      {
        outcome: "mismatched",
        declaredHandle: "x",
        authenticatedHandle: "y",
        providerAccountId: "1",
      },
    ];
    for (const result of outcomes) {
      const plan = buildDevtoVerifyPlan({
        result,
        workspaceId: WS,
        identityId: ID,
        declaredHandle: "x",
      });
      // The connected upsert has the encrypted blob (not plaintext).
      // The mismatched upsert has null tokens.
      const serialized = JSON.stringify(plan).toLowerCase();
      expect(serialized).not.toContain("leak-probe-devto-key");
    }
  });
});
