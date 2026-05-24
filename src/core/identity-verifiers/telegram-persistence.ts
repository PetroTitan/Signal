/**
 * Telegram persistence helper.
 *
 * Unlike dev.to / Hashnode / Bluesky, Telegram identities do NOT
 * persist a per-identity secret. The bot token is workspace-level
 * (TELEGRAM_BOT_TOKEN env var); the per-identity row carries only
 * the channel binding (chat_id + username). Publishing reads the
 * bot token from env at runtime; the connection row tells it which
 * chat to post to.
 *
 * As a result the upsert plan never encrypts anything. The encrypted
 * columns are always null for Telegram rows.
 */

import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type { TelegramVerifierResult } from "./telegram";

export interface TelegramVerifyPlanInput {
  result: TelegramVerifierResult;
  workspaceId: string;
  identityId: string;
  declaredHandle: string | null;
}

export interface TelegramVerifyPlan {
  upsert: UpsertConnectionInput | null;
  promoteGrowthAccount: boolean;
  response: {
    status: number;
    body: Record<string, unknown>;
  };
}

const VERIFICATION_METHOD = "telegram.bot.getChat+getChatMember";

export function buildTelegramVerifyPlan(
  input: TelegramVerifyPlanInput,
): TelegramVerifyPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;

  if (result.outcome === "connected") {
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "telegram",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: `@${result.authenticatedHandle}`,
      scopes: [],
      // No per-identity secret. The workspace bot token lives on
      // env; the row only carries the channel binding.
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "connected",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        last_message: `Bot has admin access to @${result.authenticatedHandle}.`,
      },
    };
    return {
      upsert,
      promoteGrowthAccount: true,
      response: {
        status: 200,
        body: {
          ok: true,
          platform: "telegram",
          identity_id: identityId,
          authenticated_handle: result.authenticatedHandle,
          provider_account_id: result.providerAccountId,
        },
      },
    };
  }

  if (result.outcome === "mismatched") {
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "telegram",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: `@${result.authenticatedHandle}`,
      scopes: [],
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "error",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        last_message: `Resolved to @${result.authenticatedHandle}, but identity expected ${result.declaredHandle}.`,
        handle_mismatch: {
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          observedAt: new Date().toISOString(),
        },
      },
    };
    return {
      upsert,
      promoteGrowthAccount: false,
      response: {
        status: 409,
        body: {
          ok: false,
          code: "handle_mismatch",
          platform: "telegram",
          identity_id: identityId,
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          message:
            "The chat handle resolved to a different channel. Update the identity handle or verify against the correct channel.",
        },
      },
    };
  }

  // result.outcome === "error" — no row written.
  // bot_not_admin and chat_not_found both surface clear actionable
  // text and a 4xx; credentials_missing is a server-config issue
  // (503); the rest map to standard provider/network codes.
  const httpStatus =
    result.code === "credentials_missing"
      ? 503
      : result.code === "bot_not_admin" ||
          result.code === "chat_not_found" ||
          result.code === "handle_invalid"
        ? 400
        : result.code === "network_error"
          ? 503
          : 502;
  return {
    upsert: null,
    promoteGrowthAccount: false,
    response: {
      status: httpStatus,
      body: {
        ok: false,
        code: result.code,
        platform: "telegram",
        identity_id: identityId,
        declared: declaredHandle,
        message: result.message,
      },
    },
  };
}
