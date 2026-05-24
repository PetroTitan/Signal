import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHashnodeVerifyPlan } from "./hashnode-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { HashnodeVerifierResult } from "./hashnode";

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

describe("buildHashnodeVerifyPlan — connected", () => {
  const result: HashnodeVerifierResult = {
    outcome: "connected",
    providerAccountId: "user_abc123",
    authenticatedHandle: "webmasterid",
    apiKey: "PLAINTEXT-HASHNODE-API-KEY",
  };

  it("upsert targets the right workspace + identity + platform", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.workspaceId).toBe(WS);
    expect(plan.upsert!.accountId).toBe(ID);
    expect(plan.upsert!.platform).toBe("hashnode");
  });

  it("stores Hashnode id as provider_account_id, canonical username as handle", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.providerAccountId).toBe("user_abc123");
    expect(plan.upsert!.handle).toBe("webmasterid");
  });

  it("encrypts the API key (envelope is NOT the plaintext)", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const access = plan.upsert!.accessTokenEncrypted!;
    expect(access).not.toBe("PLAINTEXT-HASHNODE-API-KEY");
    expect(access).not.toContain("PLAINTEXT-HASHNODE-API-KEY");
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("stores connection_status='connected'", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.connectionStatus).toBe("connected");
  });

  it("response is 200 with username + id — NEVER the API key", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.response.status).toBe(200);
    const body = plan.response.body;
    expect(body.ok).toBe(true);
    expect(body.authenticated_handle).toBe("webmasterid");
    expect(body.provider_account_id).toBe("user_abc123");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PLAINTEXT-HASHNODE-API-KEY");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });

  it("metadata stores diagnostic info only (no API key, no Authorization header)", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(
      ["last_message", "token_storage", "verification_method"].sort(),
    );
    const serialized = JSON.stringify(meta).toLowerCase();
    expect(serialized).not.toContain("plaintext-hashnode-api-key");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("bearer");
  });

  it("promotes growth_accounts.connection_status to 'connected'", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.promoteGrowthAccount).toBe(true);
  });

  it("upserted row resolves to 'connected' via resolveIdentityPublishState", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
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
        platform: "hashnode",
        workspaceId: WS,
        declaredHandle: "webmasterid",
        disabled: false,
        lifecycleStatus: "active",
      },
      platform: { publishingMode: "api" },
      workspace: null,
      connection,
    });
    expect(verdict).toBe("connected");
  });
});

describe("buildHashnodeVerifyPlan — mismatched", () => {
  const result: HashnodeVerifierResult = {
    outcome: "mismatched",
    declaredHandle: "webmasterid",
    authenticatedHandle: "someoneelse",
    providerAccountId: "user_xyz",
  };

  it("writes audit row with connection_status='error' and handle_mismatch metadata", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.connectionStatus).toBe("error");
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.handle_mismatch).toEqual(
      expect.objectContaining({
        declared: "webmasterid",
        authenticated: "someoneelse",
      }),
    );
  });

  it("does NOT persist the API key on mismatch (encrypted column is null)", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("does NOT promote growth_accounts on mismatch", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.promoteGrowthAccount).toBe(false);
  });

  it("response is 409 with declared + authenticated handles", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.response.status).toBe(409);
    expect(plan.response.body.code).toBe("handle_mismatch");
    expect(plan.response.body.declared).toBe("webmasterid");
    expect(plan.response.body.authenticated).toBe("someoneelse");
  });

  it("upserted row resolves to 'mismatched' via resolveIdentityPublishState", () => {
    const plan = buildHashnodeVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
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
        platform: "hashnode",
        workspaceId: WS,
        declaredHandle: "webmasterid",
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

describe("buildHashnodeVerifyPlan — error outcomes", () => {
  it("auth_failed → 401, no upsert", () => {
    const plan = buildHashnodeVerifyPlan({
      result: {
        outcome: "error",
        code: "auth_failed",
        message: "Hashnode rejected.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(401);
  });

  it("credentials_missing → 400, no upsert", () => {
    const plan = buildHashnodeVerifyPlan({
      result: {
        outcome: "error",
        code: "credentials_missing",
        message: "Need a key.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("handle_invalid → 400, no upsert", () => {
    const plan = buildHashnodeVerifyPlan({
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
    const plan = buildHashnodeVerifyPlan({
      result: {
        outcome: "error",
        code: "network_error",
        message: "Down.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
  });

  it("provider_error → 502, no upsert", () => {
    const plan = buildHashnodeVerifyPlan({
      result: {
        outcome: "error",
        code: "provider_error",
        message: "GraphQL error.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(502);
  });
});

describe("buildHashnodeVerifyPlan — token storage refusal", () => {
  it("returns 503 token_storage_unavailable when TOKEN_ENCRYPTION_KEY is missing", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    vi.resetModules();
    const { buildHashnodeVerifyPlan: buildFresh } = await import(
      "./hashnode-persistence"
    );
    const plan = buildFresh({
      result: {
        outcome: "connected",
        providerAccountId: "1",
        authenticatedHandle: "webmasterid",
        apiKey: "PLAINTEXT-KEY",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
    expect(plan.response.body.code).toBe("token_storage_unavailable");
    expect(String(plan.response.body.message ?? "").toLowerCase()).toContain(
      "server session encryption",
    );
  });
});

describe("buildHashnodeVerifyPlan — safety", () => {
  it("no outcome introduces the API key value into the serialized plan", () => {
    const outcomes: HashnodeVerifierResult[] = [
      {
        outcome: "connected",
        providerAccountId: "1",
        authenticatedHandle: "x",
        apiKey: "LEAK-PROBE-HASHNODE-KEY",
      },
      {
        outcome: "mismatched",
        declaredHandle: "x",
        authenticatedHandle: "y",
        providerAccountId: "1",
      },
    ];
    for (const result of outcomes) {
      const plan = buildHashnodeVerifyPlan({
        result,
        workspaceId: WS,
        identityId: ID,
        declaredHandle: "x",
      });
      const serialized = JSON.stringify(plan).toLowerCase();
      expect(serialized).not.toContain("leak-probe-hashnode-key");
    }
  });
});
