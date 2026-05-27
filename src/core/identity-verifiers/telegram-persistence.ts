/**
 * Telegram persistence helper.
 *
 * Unlike dev.to / Hashnode / Bluesky, Telegram identities do NOT
 * persist a per-identity secret. The bot token is workspace-level
 * (TELEGRAM_BOT_TOKEN env var); the per-identity row carries only
 * the target binding (chat_id + canonical username/title + target
 * type). Publishing reads the bot token from env at runtime; the
 * connection row tells it which chat to post to.
 *
 * Telegram targets supported (one per identity):
 *   - channel
 *   - group
 *   - supergroup
 *
 * The target_type is operator-declared at verify time and validated
 * by the verifier against Telegram's `chat.type`. The persisted
 * metadata reflects what the verifier confirmed:
 *
 *   metadata.telegram_target_type   "channel" | "group" | "supergroup"
 *   metadata.telegram_target_label  chat.title (preferred) or @username
 *   metadata.telegram_verified_at   ISO timestamp of this verification
 *   metadata.telegram_can_post      true (only set when verification
 *                                    passed the per-type permission
 *                                    check)
 *
 * Backward compatibility: existing rows persisted before this PR
 * carry only `{ verification_method, last_message }`. Readers MUST
 * default `telegram_target_type` to "channel" when the field is
 * absent (this matches the pre-PR verifier behavior, which only
 * verified channels).
 *
 * As a result the upsert plan never encrypts anything. The encrypted
 * columns are always null for Telegram rows.
 */

import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type {
  TelegramTargetType,
  TelegramVerifierResult,
} from "./telegram";

export interface TelegramVerifyPlanInput {
  result: TelegramVerifierResult;
  workspaceId: string;
  identityId: string;
  declaredHandle: string | null;
  /**
   * Existing connection metadata to preserve across the upsert.
   * Optional; when absent the upsert writes only the fields the
   * verifier just produced + the standard verification_method /
   * last_message keys. Callers (the verify route) pass through the
   * existing row's metadata so unrelated keys aren't clobbered.
   */
  existingMetadata?: Record<string, unknown> | null;
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

/**
 * Read the canonical target type from a connection's metadata,
 * defaulting to "channel" for legacy rows that predate this PR.
 *
 * Exported so scheduler / publisher diagnostics and UI rendering
 * share one parser. Pure.
 */
export function readTelegramTargetType(
  metadata: unknown,
): TelegramTargetType {
  if (!metadata || typeof metadata !== "object") return "channel";
  const raw = (metadata as Record<string, unknown>).telegram_target_type;
  if (raw === "channel" || raw === "group" || raw === "supergroup") {
    return raw;
  }
  return "channel";
}

export function buildTelegramVerifyPlan(
  input: TelegramVerifyPlanInput,
): TelegramVerifyPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;
  const existingMetadata =
    input.existingMetadata && typeof input.existingMetadata === "object"
      ? (input.existingMetadata as Record<string, unknown>)
      : {};

  if (result.outcome === "connected") {
    // Pretty operator-facing copy depending on target type. The
    // canonical machine-readable type stays in
    // metadata.telegram_target_type; this string is for last_message
    // only and is never authoritative.
    const lastMessage =
      result.targetType === "channel"
        ? `Bot has admin access to ${result.targetLabel}.`
        : `Bot is a member of ${result.targetLabel}.`;
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "telegram",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.targetLabel,
      scopes: [],
      // No per-identity secret. The workspace bot token lives on
      // env; the row only carries the target binding.
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "connected",
      metadata: {
        // Preserve any unrelated keys from the existing metadata
        // (e.g. operator-set notes). Verify-specific keys below
        // overwrite their previous values intentionally — the new
        // verification supersedes the old one.
        ...existingMetadata,
        verification_method: VERIFICATION_METHOD,
        last_message: lastMessage,
        telegram_target_type: result.targetType,
        telegram_target_label: result.targetLabel,
        telegram_verified_at: new Date().toISOString(),
        telegram_can_post: result.canPost,
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
          telegram_target_type: result.targetType,
          telegram_target_label: result.targetLabel,
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
        ...existingMetadata,
        verification_method: VERIFICATION_METHOD,
        last_message: `Resolved to @${result.authenticatedHandle}, but identity expected ${result.declaredHandle}.`,
        handle_mismatch: {
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          observedAt: new Date().toISOString(),
        },
        // Do NOT set telegram_can_post here — verification failed.
        // We don't refresh telegram_target_type either; the previous
        // verified type (if any) on existingMetadata is preserved.
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
            "The chat handle resolved to a different account. Update the identity handle or verify against the correct target.",
        },
      },
    };
  }

  // result.outcome === "error" — no row written.
  // bot_not_admin / bot_not_member / bot_cannot_send / chat_not_found
  // / chat_type_mismatch surface clear actionable text and a 4xx;
  // credentials_missing is a server-config issue (503);
  // target_type_invalid + target_invalid + handle_invalid are 400
  // (operator input issue); the rest map to standard provider /
  // network codes.
  const httpStatus =
    result.code === "credentials_missing"
      ? 503
      : result.code === "bot_not_admin" ||
          result.code === "bot_not_member" ||
          result.code === "bot_cannot_send" ||
          result.code === "chat_not_found" ||
          result.code === "chat_type_mismatch" ||
          result.code === "target_invalid" ||
          result.code === "target_type_invalid" ||
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
