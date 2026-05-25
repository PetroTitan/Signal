import { describe, expect, it } from "vitest";
import { evaluatePublishingPolicy, type PolicyContext } from "./publishing-policy";
import type { PublishRequest } from "./publishing-types";

function makeRequest(
  overrides: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    workspaceId: "w1",
    planItemId: "p1",
    executionItemId: "e1",
    platform: "bluesky",
    accountId: "acc-1",
    productId: null,
    title: null,
    body: "Hello.",
    linkUrl: null,
    target: null,
    mode: "live",
    ...overrides,
  } as PublishRequest;
}

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    request: makeRequest(),
    hasActiveContract: true,
    accountReviewStatus: "confirmed",
    productReviewStatus: null,
    connectionStatus: "connected",
    hasStoredAccessToken: true,
    scheduledFor: "2026-05-25T00:00:00.000Z",
    nowIso: "2026-05-25T01:00:00.000Z",
    publishingEnabled: true,
    riskLevel: "low",
    ...overrides,
  };
}

describe("evaluatePublishingPolicy — happy path", () => {
  it("returns null (no verdict — caller proceeds to publish) when every gate is satisfied", () => {
    const v = evaluatePublishingPolicy(makeCtx());
    expect(v).toBe(null);
  });
});

describe("evaluatePublishingPolicy — contract-free regression guard", () => {
  it("does NOT block publish when hasActiveContract is false (contract-free per-post)", () => {
    // The pre-PR-91 behavior was to block here with reason_code
    // 'no_active_contract'. Post contract-free migration, this gate
    // is removed. Bulk approval flows still gate on contract at
    // APPROVAL time; this is the PUBLISH-time gate.
    const v = evaluatePublishingPolicy(
      makeCtx({ hasActiveContract: false }),
    );
    expect(v).toBe(null);
  });

  it("contract-free + Bluesky + all other gates pass → null verdict", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({
        hasActiveContract: false,
        request: makeRequest({ platform: "bluesky" }),
      }),
    );
    expect(v).toBe(null);
  });

  it("contract-free + Reddit + all other gates pass → null verdict", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({
        hasActiveContract: false,
        request: makeRequest({ platform: "reddit", target: "test" }),
      }),
    );
    expect(v).toBe(null);
  });
});

describe("evaluatePublishingPolicy — dry-run + disabled", () => {
  it("skips with execution_mode_dry_run when request.mode === 'dry_run'", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ request: makeRequest({ mode: "dry_run" }) }),
    );
    expect(v?.status).toBe("skipped");
    expect(v?.reasonCode).toBe("execution_mode_dry_run");
  });

  it("blocks with publishing_disabled when publishingEnabled is false", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ publishingEnabled: false }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("publishing_disabled");
  });
});

describe("evaluatePublishingPolicy — identity + product confirmation", () => {
  it("blocks with account_not_confirmed when accountReviewStatus !== 'confirmed'", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ accountReviewStatus: "pending" }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("account_not_confirmed");
  });

  it("blocks with product_not_confirmed when product is set but not confirmed", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ productReviewStatus: "pending" }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("product_not_confirmed");
  });

  it("does NOT block when productReviewStatus is null (no product attached)", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ productReviewStatus: null }),
    );
    expect(v).toBe(null);
  });
});

describe("evaluatePublishingPolicy — OAuth / token / connection", () => {
  it("blocks with oauth_not_connected when connectionStatus !== 'connected'", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ connectionStatus: "disconnected" }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("oauth_not_connected");
  });

  it("blocks with oauth_token_not_stored when hasStoredAccessToken is false", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ hasStoredAccessToken: false }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("oauth_token_not_stored");
  });
});

describe("evaluatePublishingPolicy — risk + schedule", () => {
  it("blocks with risk_level_blocked when QA flagged the item", () => {
    const v = evaluatePublishingPolicy(makeCtx({ riskLevel: "blocked" }));
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("risk_level_blocked");
  });

  it("skips with scheduled_in_future when scheduled_for > now", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({
        scheduledFor: "2026-05-26T00:00:00.000Z",
        nowIso: "2026-05-25T01:00:00.000Z",
      }),
    );
    expect(v?.status).toBe("skipped");
    expect(v?.reasonCode).toBe("scheduled_in_future");
  });

  it("does NOT skip when scheduled_for <= now", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({
        scheduledFor: "2026-05-25T00:00:00.000Z",
        nowIso: "2026-05-25T01:00:00.000Z",
      }),
    );
    expect(v).toBe(null);
  });
});

describe("evaluatePublishingPolicy — invariant", () => {
  it("never returns a no_active_contract verdict (removed in PR #94)", () => {
    // Iterate over a small fuzz of states.
    for (const hasActiveContract of [true, false]) {
      for (const accountReviewStatus of ["confirmed", "pending"]) {
        for (const connectionStatus of ["connected", "disconnected"]) {
          const v = evaluatePublishingPolicy(
            makeCtx({
              hasActiveContract,
              accountReviewStatus,
              connectionStatus,
            }),
          );
          expect(v?.reasonCode).not.toBe("no_active_contract");
        }
      }
    }
  });
});
