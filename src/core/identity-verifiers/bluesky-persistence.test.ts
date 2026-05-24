import { describe, expect, it } from "vitest";
import { buildBlueskyVerifyPlan } from "./bluesky-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { BlueskyVerifierResult } from "./bluesky";

const WS = "ws-1";
const ID = "id-1";

// =====================================================================
// Verified outcome — happy path
// =====================================================================

describe("buildBlueskyVerifyPlan — verified", () => {
  const result: BlueskyVerifierResult = {
    outcome: "verified",
    providerAccountId: "did:plc:abc123",
    authenticatedHandle: "webmasterid.bsky.social",
  };

  it("upsert targets the right workspace + identity + platform", () => {
    const plan = buildBlueskyVerifyPlan({
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

  it("stores the DID as provider_account_id and the canonical handle as handle", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.providerAccountId).toBe("did:plc:abc123");
    expect(plan.upsert!.handle).toBe("webmasterid.bsky.social");
  });

  it("stores connection_status='connected'", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.connectionStatus).toBe("connected");
  });

  it("does NOT store any token, app password, or secret in metadata", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
    // Metadata keys are explicitly enumerated — only diagnostic info.
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(
      ["last_message", "verification_method"].sort(),
    );
    expect(JSON.stringify(meta).toLowerCase()).not.toContain("token");
    expect(JSON.stringify(meta).toLowerCase()).not.toContain("password");
    expect(JSON.stringify(meta).toLowerCase()).not.toContain("api_key");
    expect(JSON.stringify(meta).toLowerCase()).not.toContain("bearer");
  });

  it("response is 200 OK with the public DID + handle", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.response.status).toBe(200);
    expect(plan.response.body.ok).toBe(true);
    expect(plan.response.body.authenticated_handle).toBe(
      "webmasterid.bsky.social",
    );
    expect(plan.response.body.provider_account_id).toBe("did:plc:abc123");
  });

  it("promotes growth_accounts.connection_status to 'connected'", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.promoteGrowthAccount).toBe(true);
  });

  it("the upserted row, fed into resolveIdentityPublishState, resolves to 'connected'", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).not.toBeNull();
    const connection: IdentityConnection = {
      authStatus: narrowConnectionAuthStatus(plan.upsert!.connectionStatus),
      platform: plan.upsert!.platform,
      workspaceId: plan.upsert!.workspaceId,
      authenticatedHandle: plan.upsert!.handle,
      providerAccountId: plan.upsert!.providerAccountId,
      handleMismatchObserved: false,
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
// Mismatched outcome — declared handle resolves to a different DID
// =====================================================================

describe("buildBlueskyVerifyPlan — mismatched", () => {
  const result: BlueskyVerifierResult = {
    outcome: "mismatched",
    declaredHandle: "webmasterid.bsky.social",
    authenticatedHandle: "someoneelse.bsky.social",
    providerAccountId: "did:plc:xyz",
  };

  it("upserts a row with connection_status='error' and handle_mismatch metadata", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.connectionStatus).toBe("error");
    const mismatch = (plan.upsert!.metadata as Record<string, unknown>)
      .handle_mismatch as Record<string, unknown>;
    expect(mismatch.declared).toBe("webmasterid.bsky.social");
    expect(mismatch.authenticated).toBe("someoneelse.bsky.social");
    expect(typeof mismatch.observedAt).toBe("string");
  });

  it("does NOT promote growth_accounts to 'connected'", () => {
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.promoteGrowthAccount).toBe(false);
  });

  it("response is 409 with the declared+authenticated handles", () => {
    const plan = buildBlueskyVerifyPlan({
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
    const plan = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).not.toBeNull();
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
// Error outcomes — no connection row should be written
// =====================================================================

describe("buildBlueskyVerifyPlan — error outcomes", () => {
  it("handle_invalid: no upsert, response is 400", () => {
    const plan = buildBlueskyVerifyPlan({
      result: {
        outcome: "error",
        code: "handle_invalid",
        message: "Handle empty.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: null,
    });
    expect(plan.upsert).toBeNull();
    expect(plan.promoteGrowthAccount).toBe(false);
    expect(plan.response.status).toBe(400);
    expect(plan.response.body.code).toBe("handle_invalid");
  });

  it("handle_not_found: no upsert, response is 400", () => {
    const plan = buildBlueskyVerifyPlan({
      result: {
        outcome: "error",
        code: "handle_not_found",
        message: "Not found.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "missing.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
    expect(plan.response.body.code).toBe("handle_not_found");
  });

  it("network_error: no upsert, response is 503", () => {
    const plan = buildBlueskyVerifyPlan({
      result: {
        outcome: "error",
        code: "network_error",
        message: "Network down.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
  });

  it("provider_error: no upsert, response is 502", () => {
    const plan = buildBlueskyVerifyPlan({
      result: {
        outcome: "error",
        code: "provider_error",
        message: "Provider returned malformed body.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(502);
  });
});

// =====================================================================
// Idempotency — repeated verification produces an equivalent plan
// =====================================================================

describe("buildBlueskyVerifyPlan — idempotency", () => {
  it("two calls with the same verified result produce structurally identical upserts (modulo timestamps)", () => {
    const result: BlueskyVerifierResult = {
      outcome: "verified",
      providerAccountId: "did:plc:abc",
      authenticatedHandle: "webmasterid.bsky.social",
    };
    const first = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    const second = buildBlueskyVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid.bsky.social",
    });
    // Verified path's metadata has no timestamp, so it's identical.
    expect(first).toEqual(second);
  });
});

// =====================================================================
// Safety — no leak across outcomes
// =====================================================================

describe("buildBlueskyVerifyPlan — safety", () => {
  it("no outcome introduces an Authorization or token field in metadata", () => {
    const outcomes: BlueskyVerifierResult[] = [
      {
        outcome: "verified",
        providerAccountId: "did:plc:abc",
        authenticatedHandle: "x.bsky.social",
      },
      {
        outcome: "mismatched",
        declaredHandle: "x.bsky.social",
        authenticatedHandle: "y.bsky.social",
        providerAccountId: "did:plc:xyz",
      },
    ];
    for (const result of outcomes) {
      const plan = buildBlueskyVerifyPlan({
        result,
        workspaceId: WS,
        identityId: ID,
        declaredHandle: "x.bsky.social",
      });
      if (!plan.upsert) continue;
      const serialized = JSON.stringify(plan.upsert).toLowerCase();
      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("bearer");
      expect(serialized).not.toContain("app_password");
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("access_token");
      expect(plan.upsert.accessTokenEncrypted).toBeNull();
      expect(plan.upsert.refreshTokenEncrypted).toBeNull();
    }
  });
});
