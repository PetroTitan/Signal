import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getAccountById,
  setAccountConnectionStatus,
} from "@/repositories/account-repository";
import { upsertPlatformConnection } from "@/repositories/platform-connection-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  verifyTelegramIdentity,
  buildTelegramVerifyPlan,
  isTelegramTargetType,
} from "@/core/identity-verifiers";
import { readTelegramCredentials } from "@/core/publishing/platform-credentials";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";

/**
 * POST /api/identity/:identityId/telegram/verify
 *
 * Optional JSON body:
 *   {
 *     target_type?: "channel" | "group" | "supergroup",   // defaults to "channel" for back-compat
 *     target?:      string                                // @username OR numeric chat id like "-1001234567890"
 *   }
 *
 * Both fields are optional:
 *   - `target_type` defaults to "channel" so existing callers (the
 *     pre-PR UI that posted no body) continue to verify channels
 *     exactly as before. Pass "group" or "supergroup" to verify a
 *     different target type.
 *   - `target` overrides the identity's declared handle when set.
 *     Required for PRIVATE groups/supergroups whose chat has no
 *     public @username — operator pastes the numeric chat id.
 *
 * Telegram credentials are workspace-level (TELEGRAM_BOT_TOKEN env
 * var); the operator only clicks "Verify" once the bot has been
 * added to the target.
 *
 * Verifies the per-identity target binding:
 *   1. Auth + workspace + identity gate (caller must own the row).
 *   2. Identity platform must be "telegram".
 *   3. Parse + validate the optional body (target_type, target).
 *   4. Load existing connection metadata so unrelated keys
 *      (operator notes, anything we haven't seen yet) survive the
 *      upsert.
 *   5. Read workspace bot token from env.
 *   6. Call Telegram getMe → bot.id.
 *   7. Call getChat(target) → chat.id + chat.type + chat.title +
 *      chat.username.
 *   8. Validate the declared target_type matches Telegram's
 *      chat.type (refuses chat_type_mismatch otherwise).
 *   9. Compare canonical username (when public) to identity's
 *      declared handle.
 *   10. Call getChatMember and run the per-target-type permission
 *       check (channel: admin + can_post; group/supergroup: member-
 *       or-above + can_send).
 *   11. On success: upsert row with chat_id + canonical username +
 *       target type + label + verified-at + can-post + the existing
 *       metadata.
 *
 * Security boundaries:
 *   - The bot token NEVER appears in the response body, metadata,
 *     activity log, or error message. Provider error strings are
 *     redacted (the token is replaced with "<redacted>" if found).
 *   - The response carries only the public chat_id + canonical
 *     username + target type + label + verification status. The
 *     chat id is operator-visible (Telegram shows it in admin UIs)
 *     and is not treated as a secret.
 *   - On bot_not_admin / bot_not_member / bot_cannot_send: no row
 *     is written; the operator is told what action to take.
 */
export async function POST(
  request: Request,
  { params }: { params: { identityId: string } },
) {
  try {
    const identityId = params.identityId?.trim();
    if (!identityId) {
      return jsonError(400, "identity_id_required", "Missing identityId.");
    }

    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return jsonError(401, "not_authenticated", "Sign in first.");
    }

    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return jsonError(400, "no_workspace", "No workspace found.");
    }

    let identity;
    try {
      identity = await getAccountById(membership.workspace.id, identityId);
    } catch {
      return jsonError(404, "identity_not_found", "Identity not found.");
    }

    if (identity.platform !== "telegram") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts Telegram identities only; this identity is on "${identity.platform}".`,
      );
    }

    // Parse optional body. Empty / unparsable body is treated as
    // "no body" — back-compat with the pre-PR UI that sent no
    // payload at all.
    let body: { target_type?: unknown; target?: unknown } = {};
    try {
      const text = await request.text();
      if (text && text.trim().length > 0) {
        body = JSON.parse(text) as typeof body;
      }
    } catch {
      return jsonError(400, "invalid_body", "Request body must be JSON.");
    }
    const rawTargetType = body.target_type;
    if (
      rawTargetType !== undefined &&
      !(typeof rawTargetType === "string" && isTelegramTargetType(rawTargetType))
    ) {
      return jsonError(
        400,
        "target_type_invalid",
        'target_type must be one of: "channel", "group", "supergroup".',
      );
    }
    const targetType = isTelegramTargetType(rawTargetType)
      ? rawTargetType
      : "channel"; // back-compat default
    const target =
      typeof body.target === "string" && body.target.trim().length > 0
        ? body.target.trim()
        : null;

    // Preserve existing connection metadata so unrelated keys
    // (notes, future fields) survive the upsert. Tolerates the
    // no-row case (first-time verify) by passing {} through.
    let existingMetadata: Record<string, unknown> | null = null;
    try {
      const existing = await getConnectionForAccount(
        membership.workspace.id,
        identityId,
        "telegram" as never,
      );
      existingMetadata =
        existing &&
        existing.metadata &&
        typeof existing.metadata === "object"
          ? (existing.metadata as Record<string, unknown>)
          : null;
    } catch {
      existingMetadata = null;
    }

    // Read workspace bot token. If missing, we still hit the
    // verifier (which surfaces credentials_missing) so the operator
    // gets a consistent error shape. The token is held only for the
    // duration of this function.
    const creds = readTelegramCredentials();

    const verifyResult = await verifyTelegramIdentity({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? "",
      targetType,
      target,
      botToken: creds?.botToken ?? "",
    });

    const plan = buildTelegramVerifyPlan({
      result: verifyResult,
      workspaceId: membership.workspace.id,
      identityId,
      declaredHandle: identity.handle,
      existingMetadata,
    });

    if (plan.upsert) {
      try {
        const conn = await upsertPlatformConnection(plan.upsert);
        try {
          await recordActivity({
            workspaceId: membership.workspace.id,
            eventType:
              plan.upsert.connectionStatus === "connected"
                ? "platform_connection.connected"
                : "platform_connection.failed",
            entityType: "platform_connection",
            entityId: conn.id,
            title:
              plan.upsert.connectionStatus === "connected"
                ? `Telegram verified as @${plan.upsert.handle}`
                : "Telegram handle mismatch",
            description:
              typeof plan.upsert.metadata?.last_message === "string"
                ? plan.upsert.metadata.last_message
                : null,
          });
        } catch (err) {
          console.error("[telegram/verify] activity log failed", err);
        }
      } catch (err) {
        console.error("[telegram/verify] upsert failed", err);
        return jsonError(
          500,
          "persist_failed",
          "Could not persist the connection.",
        );
      }
    }

    if (plan.promoteGrowthAccount) {
      try {
        await setAccountConnectionStatus({
          workspaceId: membership.workspace.id,
          accountId: identityId,
          connectionStatus: "connected",
        });
      } catch (err) {
        console.error(
          "[telegram/verify] growth_accounts promote failed",
          err,
        );
      }
    }

    return NextResponse.json(plan.response.body, {
      status: plan.response.status,
    });
  } catch (err) {
    console.error("[telegram/verify] unexpected error", err);
    return jsonError(500, "unknown", "Unexpected error.");
  }
}

function jsonError(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json({ ok: false, code, error: message }, { status });
}
