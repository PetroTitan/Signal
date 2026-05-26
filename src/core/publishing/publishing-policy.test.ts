import { describe, expect, it } from "vitest";
import {
  evaluatePublishingPolicy,
  usesWorkspaceCredential,
  type PolicyContext,
} from "./publishing-policy";
import type { PublishPlatform, PublishRequest } from "./publishing-types";

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

  it("blocks with oauth_token_not_stored when hasStoredAccessToken is false (default platform = bluesky)", () => {
    const v = evaluatePublishingPolicy(
      makeCtx({ hasStoredAccessToken: false }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("oauth_token_not_stored");
  });
});

// =====================================================================
// Workspace-credential platforms (Telegram).
//
// Telegram's bot token lives in env (TELEGRAM_BOT_TOKEN); the
// per-identity platform_connections row is intentionally token-less
// (verify route persists connection_status="connected" + chat-id
// metadata but never an encrypted access token).
//
// Pre-fix the policy gate blocked every Telegram publish with
// `oauth_token_not_stored` because `hasStoredAccessToken=false` is
// the steady state for this auth model. The check now skips for
// platforms where `usesWorkspaceCredential` is true.
//
// All other publish-time gates (connectionStatus,
// accountReviewStatus, productReviewStatus, risk, schedule) still
// apply to Telegram.
// =====================================================================

describe("evaluatePublishingPolicy — workspace-credential platforms (Telegram)", () => {
  function telegramCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
    return makeCtx({
      request: makeRequest({ platform: "telegram" }),
      ...overrides,
    });
  }

  it("Telegram with connected identity + hasStoredAccessToken=false → null (publish proceeds; regression for the oauth_token_not_stored block)", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({ hasStoredAccessToken: false }),
    );
    expect(v).toBe(null);
  });

  it("Telegram with connectionStatus !== 'connected' still blocks with oauth_not_connected", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        connectionStatus: "disconnected",
      }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("oauth_not_connected");
  });

  it("Telegram still blocked by account_not_confirmed (other identity gates still apply)", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        accountReviewStatus: "pending",
      }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("account_not_confirmed");
  });

  it("Telegram still blocked by risk_level=blocked (QA gate still applies)", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        riskLevel: "blocked",
      }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("risk_level_blocked");
  });

  it("Telegram still skipped by scheduled_in_future (time gate still applies)", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        scheduledFor: "2026-05-26T00:00:00.000Z",
        nowIso: "2026-05-25T01:00:00.000Z",
      }),
    );
    expect(v?.status).toBe("skipped");
    expect(v?.reasonCode).toBe("scheduled_in_future");
  });

  it("Telegram still skipped by dry_run mode", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        request: makeRequest({ platform: "telegram", mode: "dry_run" }),
      }),
    );
    expect(v?.status).toBe("skipped");
    expect(v?.reasonCode).toBe("execution_mode_dry_run");
  });

  it("Telegram still blocked by publishing_disabled", () => {
    const v = evaluatePublishingPolicy(
      telegramCtx({
        hasStoredAccessToken: false,
        publishingEnabled: false,
      }),
    );
    expect(v?.status).toBe("blocked");
    expect(v?.reasonCode).toBe("publishing_disabled");
  });

  it("Telegram with everything healthy passes regardless of token state", () => {
    // Mirror the live state of the deployed Telegram identity:
    // verified, connected, healthy, no encrypted token.
    expect(
      evaluatePublishingPolicy(
        telegramCtx({ hasStoredAccessToken: false }),
      ),
    ).toBe(null);
    expect(
      evaluatePublishingPolicy(
        telegramCtx({ hasStoredAccessToken: true }),
      ),
    ).toBe(null);
  });
});

// =====================================================================
// Cross-platform regression — non-Telegram platforms must continue
// to block on hasStoredAccessToken=false. The narrow Telegram
// carve-out must NOT relax any OAuth / per-identity-credential
// platform.
// =====================================================================

describe("evaluatePublishingPolicy — non-Telegram platforms still gated on hasStoredAccessToken", () => {
  it.each<PublishPlatform>(["bluesky", "reddit", "devto", "hashnode", "x", "linkedin"])(
    "%s with hasStoredAccessToken=false still blocks with oauth_token_not_stored",
    (platform) => {
      const v = evaluatePublishingPolicy(
        makeCtx({
          request: makeRequest({ platform }),
          hasStoredAccessToken: false,
        }),
      );
      expect(v?.status).toBe("blocked");
      expect(v?.reasonCode).toBe("oauth_token_not_stored");
    },
  );
});

describe("usesWorkspaceCredential helper", () => {
  it("is true ONLY for telegram today", () => {
    expect(usesWorkspaceCredential("telegram")).toBe(true);
  });

  it.each<PublishPlatform>([
    "bluesky",
    "reddit",
    "devto",
    "hashnode",
    "x",
    "linkedin",
    "instagram",
    "threads",
    "youtube",
  ])("is false for %s (per-identity credential platforms)", (platform) => {
    expect(usesWorkspaceCredential(platform)).toBe(false);
  });

  it("is false for null / undefined platform", () => {
    expect(usesWorkspaceCredential(null)).toBe(false);
    expect(usesWorkspaceCredential(undefined)).toBe(false);
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
