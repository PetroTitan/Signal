import { describe, expect, it } from "vitest";
import {
  buildTelegramVerifyPlan,
  readTelegramTargetType,
} from "./telegram-persistence";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  type IdentityConnection,
} from "@/core/publishing/identity-publish-state";
import type { TelegramVerifierResult } from "./telegram";

const WS = "ws-1";
const ID = "id-1";

// =====================================================================
// connected — happy path (channel)
// Telegram is unique: NO encryption, NO per-identity secret stored.
// The bot token stays on env. The connection row holds only the
// target binding (chat_id + username + target_type + label).
// =====================================================================

describe("buildTelegramVerifyPlan — connected (channel)", () => {
  const result: TelegramVerifierResult = {
    outcome: "connected",
    providerAccountId: "-1001234567890",
    authenticatedHandle: "webmasterid",
    targetType: "channel",
    targetLabel: "@webmasterid",
    canPost: true,
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

  it("metadata stores verification + target-type diagnostic keys (no secrets)", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    const keys = Object.keys(meta).sort();
    expect(keys).toEqual(
      [
        "last_message",
        "telegram_can_post",
        "telegram_target_label",
        "telegram_target_type",
        "telegram_verified_at",
        "verification_method",
      ].sort(),
    );
    expect(meta.verification_method).toContain("telegram");
    expect(meta.telegram_target_type).toBe("channel");
    expect(meta.telegram_target_label).toBe("@webmasterid");
    expect(meta.telegram_can_post).toBe(true);
    expect(typeof meta.telegram_verified_at).toBe("string");
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

// =====================================================================
// connected — group + supergroup variants
// =====================================================================

describe("buildTelegramVerifyPlan — connected (group)", () => {
  it("stores telegram_target_type='group' + label + verified_at + can_post", () => {
    const result: TelegramVerifierResult = {
      outcome: "connected",
      providerAccountId: "-987654321",
      authenticatedHandle: "hackuac",
      targetType: "group",
      targetLabel: "Hack UA Group",
      canPost: true,
    };
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "hackuac",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.telegram_target_type).toBe("group");
    expect(meta.telegram_target_label).toBe("Hack UA Group");
    expect(meta.telegram_can_post).toBe(true);
    expect(typeof meta.telegram_verified_at).toBe("string");
  });

  it("response body surfaces telegram_target_type + label", () => {
    const result: TelegramVerifierResult = {
      outcome: "connected",
      providerAccountId: "-987654321",
      authenticatedHandle: "hackuac",
      targetType: "group",
      targetLabel: "Hack UA Group",
      canPost: true,
    };
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "hackuac",
    });
    expect(plan.response.status).toBe(200);
    expect(plan.response.body.telegram_target_type).toBe("group");
    expect(plan.response.body.telegram_target_label).toBe("Hack UA Group");
  });

  it("group last_message uses group-shaped copy ('Bot is a member of …')", () => {
    const result: TelegramVerifierResult = {
      outcome: "connected",
      providerAccountId: "-987654321",
      authenticatedHandle: "hackuac",
      targetType: "group",
      targetLabel: "Hack UA Group",
      canPost: true,
    };
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "hackuac",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.last_message).toContain("member");
    expect(meta.last_message).toContain("Hack UA Group");
  });
});

describe("buildTelegramVerifyPlan — connected (supergroup)", () => {
  it("stores telegram_target_type='supergroup'", () => {
    const result: TelegramVerifierResult = {
      outcome: "connected",
      providerAccountId: "-1001234567890",
      authenticatedHandle: "webmasterid",
      targetType: "supergroup",
      targetLabel: "WebmasterID Supergroup",
      canPost: true,
    };
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.telegram_target_type).toBe("supergroup");
  });
});

// =====================================================================
// existingMetadata preservation — unrelated keys survive the upsert
// =====================================================================

describe("buildTelegramVerifyPlan — preserves existing metadata", () => {
  const result: TelegramVerifierResult = {
    outcome: "connected",
    providerAccountId: "-1001234567890",
    authenticatedHandle: "webmasterid",
    targetType: "channel",
    targetLabel: "@webmasterid",
    canPost: true,
  };

  it("preserves operator-set notes and other unknown keys", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
      existingMetadata: {
        operator_note: "Test channel for staging",
        future_key: { nested: true },
      },
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.operator_note).toBe("Test channel for staging");
    expect(meta.future_key).toEqual({ nested: true });
    // Verify-specific keys still overwrite their previous values
    expect(meta.verification_method).toContain("telegram");
    expect(meta.telegram_target_type).toBe("channel");
  });

  it("overwrites stale telegram_target_type when the operator re-verifies under a different type", () => {
    const plan = buildTelegramVerifyPlan({
      result,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
      existingMetadata: {
        telegram_target_type: "group", // stale — the new verify result says "channel"
        telegram_target_label: "Old Group Label",
      },
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.telegram_target_type).toBe("channel");
    expect(meta.telegram_target_label).toBe("@webmasterid");
  });

  it("does NOT clobber unrelated keys on a mismatched outcome", () => {
    const mismatch: TelegramVerifierResult = {
      outcome: "mismatched",
      declaredHandle: "webmasterid",
      authenticatedHandle: "OtherChannel",
      providerAccountId: "-100999",
    };
    const plan = buildTelegramVerifyPlan({
      result: mismatch,
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
      existingMetadata: { operator_note: "Important note" },
    });
    const meta = plan.upsert!.metadata as Record<string, unknown>;
    expect(meta.operator_note).toBe("Important note");
    expect(meta.handle_mismatch).toBeDefined();
  });
});

// =====================================================================
// readTelegramTargetType — back-compat reader for legacy rows
// =====================================================================

describe("readTelegramTargetType", () => {
  it("defaults to 'channel' for legacy rows without telegram_target_type", () => {
    expect(readTelegramTargetType(null)).toBe("channel");
    expect(readTelegramTargetType(undefined)).toBe("channel");
    expect(readTelegramTargetType({})).toBe("channel");
    expect(
      readTelegramTargetType({
        verification_method: "telegram.bot.getChat+getChatMember",
        last_message: "Bot has admin access to @webmasterid.",
      }),
    ).toBe("channel");
  });

  it("returns the persisted target type when set", () => {
    expect(
      readTelegramTargetType({ telegram_target_type: "channel" }),
    ).toBe("channel");
    expect(
      readTelegramTargetType({ telegram_target_type: "group" }),
    ).toBe("group");
    expect(
      readTelegramTargetType({ telegram_target_type: "supergroup" }),
    ).toBe("supergroup");
  });

  it("falls back to 'channel' for malformed values", () => {
    expect(
      readTelegramTargetType({ telegram_target_type: "private" }),
    ).toBe("channel");
    expect(readTelegramTargetType({ telegram_target_type: 42 })).toBe(
      "channel",
    );
    expect(
      readTelegramTargetType({ telegram_target_type: null }),
    ).toBe("channel");
  });
});

// =====================================================================
// new error codes — bot_not_member / bot_cannot_send /
// chat_type_mismatch / target_invalid / target_type_invalid
// =====================================================================

describe("buildTelegramVerifyPlan — new error codes", () => {
  it.each([
    "bot_not_member" as const,
    "bot_cannot_send" as const,
    "chat_type_mismatch" as const,
    "target_invalid" as const,
    "target_type_invalid" as const,
  ])("%s → 400, no upsert", (code) => {
    const plan = buildTelegramVerifyPlan({
      result: {
        outcome: "error",
        code,
        message: "Operator-facing message.",
      },
      workspaceId: WS,
      identityId: ID,
      declaredHandle: "webmasterid",
    });
    expect(plan.upsert).toBeNull();
    expect(plan.response.status).toBe(400);
    expect(plan.response.body.code).toBe(code);
  });
});

describe("buildTelegramVerifyPlan — safety", () => {
  it("no outcome introduces a Telegram bot token shape into the serialized plan", () => {
    const outcomes: TelegramVerifierResult[] = [
      {
        outcome: "connected",
        providerAccountId: "-100123",
        authenticatedHandle: "webmasterid",
        targetType: "channel",
        targetLabel: "@webmasterid",
        canPost: true,
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
