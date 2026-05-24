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
} from "@/core/identity-verifiers";
import { readTelegramCredentials } from "@/core/publishing/platform-credentials";

/**
 * POST /api/identity/:identityId/telegram/verify
 *
 * No request body. Telegram credentials are workspace-level
 * (TELEGRAM_BOT_TOKEN env var); the operator only clicks "Verify"
 * once the bot has been added to the channel.
 *
 * Verifies the per-identity channel binding:
 *   1. Auth + workspace + identity gate (caller must own the row).
 *   2. Identity platform must be "telegram".
 *   3. Read workspace bot token from env.
 *   4. Call Telegram getMe → bot.id.
 *   5. Call getChat(@handle) → chat.id + chat.username.
 *   6. Compare canonical username to identity's declared handle
 *      (mismatch → row written with handle_mismatch, NOT marked
 *      connected).
 *   7. Call getChatMember to confirm bot is admin with
 *      can_post_messages.
 *   8. On success: upsert row with chat_id + canonical username +
 *      connection_status='connected'. Mirror growth_accounts.
 *
 * Security boundaries:
 *   - The bot token NEVER appears in the response body, metadata,
 *     activity log, or error message. Provider error strings are
 *     redacted (the token is replaced with "<redacted>" if found).
 *   - The response carries only the public chat_id + channel
 *     username + verification status.
 *   - On bot_not_admin: no row is written; the operator is told to
 *     add the bot as admin and try again.
 */
export async function POST(
  _request: Request,
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

    // Read workspace bot token. If missing, we still hit the
    // verifier (which surfaces credentials_missing) so the operator
    // gets a consistent error shape. The token is held only for the
    // duration of this function.
    const creds = readTelegramCredentials();

    const verifyResult = await verifyTelegramIdentity({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? "",
      botToken: creds?.botToken ?? "",
    });

    const plan = buildTelegramVerifyPlan({
      result: verifyResult,
      workspaceId: membership.workspace.id,
      identityId,
      declaredHandle: identity.handle,
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
