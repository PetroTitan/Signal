import { describe, expect, it } from "vitest";
import { buildTelegramVerifyPlan } from "./telegram-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { TelegramVerifierResult } from "./telegram";

const WS = "ws-1";
const ID = "id-1";

// =====================================================================
// connected — happy path
// Telegram is unique: NO encryption, NO per-identity secret stored.
// The bot token stays on env. The connection row holds only the
// channel binding (chat_id + username).
// =====================================================================

describe("buildTelegramVerifyPlan — connected", () => {
  const result: TelegramVerifierResult = {
    outcome: "connected",
    providerAccountId: "-1001234567890",
    authenticatedHandle: "webmasterid",
  };

  it("upsert targets the right workspace + identity + platform", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).not.toBeNull();
    expect(plan.upsert!.workspaceId).toBe(WS);
    expect(plan.upsert!.accountId).toBe(ID);
    expect(plan.upsert!.platform).toBe("telegram");
  });

  it("stores chat_id as provider_account_id, canonical username as handle", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.providerAccountId).toBe("-1001234567890");
    expect(plan.upsert!.handle).toBe("webmasterid");
  });

  it("stores NO per-identity secret — encrypted columns are null (bot token stays workspace-level)", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
    expect(plan.upsert!.expiresAt).toBeNull();
  });

  it("stores connection_status='connected'", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.connectionStatus).toBe("connected");
  });

  it("response is 200 with handle + chat_id — never the bot token", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.response.status).toBe(200);
    const body = plan.response.body;
    expect(body.ok).toBe(true);
    expect(body.authenticated_handle).toBe("webmasterid");
    expect(body.provider_account_id).toBe("-1001234567890");
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain("bot");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("authorization");
  });

  it("metadata stores diagnostic info only — verification_method + last_message", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(["last_message", "verification_method"].sort());
    expect(meta.verification_method).toContain("telegram");
    const serialized = JSON.stringify(meta).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("bearer");
  });

  it("promotes growth_accounts.connection_status to 'connected'", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.promoteGrowthAccount).toBe(true);
  });

  it("upserted row resolves to 'connected' via resolveIdentityPublishState", () => {
    const plan = buildTelegramVerifyPlan({
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
        platform: "telegram",
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

// =====================================================================
// mismatched — write audit row WITHOUT promoting growth_accounts
// =====================================================================

describe("buildTelegramVerifyPlan — mismatched", () => {
  const result: TelegramVerifierResult = {
    outcome: "mismatched",
    declaredHandle: "webmasterid",
    authenticatedHandle: "OtherChannel",
    providerAccountId: "-100999",
  };

  it("writes audit row with connection_status='error' and handle_mismatch metadata", () => {
    const plan = buildTelegramVerifyPlan({
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
        authenticated: "OtherChannel",
      }),
    );
  });

  it("encrypted columns remain null on mismatch (Telegram never stores a per-identity secret)", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert!.accessTokenEncrypted).toBeNull();
    expect(plan.upsert!.refreshTokenEncrypted).toBeNull();
  });

  it("does NOT promote growth_accounts on mismatch", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.promoteGrowthAccount).toBe(false);
  });

  it("response is 409 with declared + authenticated handles", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.response.status).toBe(409);
    expect(plan.response.body.code).toBe("handle_mismatch");
    expect(plan.response.body.declared).toBe("webmasterid");
    expect(plan.response.body.authenticated).toBe("OtherChannel");
  });

  it("upserted row resolves to 'mismatched' via resolveIdentityPublishState", () => {
    const plan = buildTelegramVerifyPlan({
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
        platform: "telegram",
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

// =====================================================================
// error outcomes — no upsert, correct HTTP status
// =====================================================================

describe("buildTelegramVerifyPlan — error outcomes", () => {
  it("credentials_missing → 503, no upsert (server-config issue)", () => {
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code: "credentials_missing",
        message: "TELEGRAM_BOT_TOKEN not set.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(503);
  });

  it("bot_not_admin → 400, no upsert", () => {
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code: "bot_not_admin",
        message: "Add the bot as an admin.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("chat_not_found → 400, no upsert", () => {
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code: "chat_not_found",
        message: "Channel not found.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
  });

  it("handle_invalid → 400, no upsert", () => {
    const plan = buildTelegramVerifyPlan({
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
    const plan = buildTelegramVerifyPlan({
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
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code: "provider_error",
        message: "Telegram error.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(502);
  });

  it("error response body never includes the bot token (caller should pass redacted message; defensive verification here)", () => {
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code: "provider_error",
        message: "Telegram error after <redacted> handshake.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const serialized = JSON.stringify(plan.response.body).toLowerCase();
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("authorization");
  });
});

// =====================================================================
// safety: serialized plan never contains the bot token under any outcome
// =====================================================================

describe("buildTelegramVerifyPlan — safety", () => {
  it("no outcome introduces a Telegram bot token shape into the serialized plan", () => {
    const outcomes: TelegramVerifierResult[] = [
      {
        outcome: "connected",
        providerAccountId: "-100123",
        authenticatedHandle: "webmasterid",
      },
      {
        outcome: "mismatched",
        declaredHandle: "webmasterid",
        authenticatedHandle: "someoneelse",
        providerAccountId: "-100999",
      },
      {
        outcome: "error",
        code: "bot_not_admin",
        message: "Add the bot as an admin.",
      },
    ];
    for (const result of outcomes) {
      const plan = buildTelegramVerifyPlan({
        result,
        workspaceId: WS,
        identityId: ID,
        declaredHandle: "webmasterid",
      });
      const serialized = JSON.stringify(plan).toLowerCase();
      // Telegram bot tokens look like "<digits>:<base64ish>" — make
      // sure no string matching that shape leaked through.
      expect(serialized).not.toMatch(/\b\d{6,}:[a-z0-9_-]{20,}/i);
      expect(serialized).not.toContain("bearer");
      expect(serialized).not.toContain("telegram_bot_token");
    }
  });
});
