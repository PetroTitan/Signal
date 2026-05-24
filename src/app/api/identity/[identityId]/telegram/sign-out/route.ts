import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getAccountById,
  setAccountConnectionStatus,
} from "@/repositories/account-repository";
import {
  getConnectionForAccount,
  markConnectionStatus,
} from "@/repositories/platform-connection-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * POST /api/identity/:identityId/telegram/sign-out
 *
 * Clears the per-identity channel binding for a Telegram identity.
 * Unlike Bluesky / dev.to / Hashnode this does NOT clear any
 * encrypted secret — Telegram identities never store one. It only:
 *   - marks the connection_status='revoked'
 *   - clears handle_mismatch metadata so a re-verify starts clean
 *   - mirrors growth_accounts.connection_status='not_connected'
 *
 * Affects only THIS identity's row. The workspace bot token stays
 * in env and is unchanged.
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

    const conn = await getConnectionForAccount(
      membership.workspace.id,
      identityId,
      "telegram" as never,
    );

    if (conn) {
      try {
        await markConnectionStatus({
          workspaceId: membership.workspace.id,
          connectionId: conn.id,
          status: "revoked",
          healthStatus: "revoked",
          message: "Operator signed out of this Telegram channel.",
          clearMetadataKeys: ["handle_mismatch"],
        });
      } catch (err) {
        console.error(
          "[telegram/sign-out] markConnectionStatus failed",
          err,
        );
        return jsonError(
          500,
          "sign_out_failed",
          "Could not sign out of this channel.",
        );
      }
      try {
        await recordActivity({
          workspaceId: membership.workspace.id,
          eventType: "platform_connection.disconnected",
          entityType: "platform_connection",
          entityId: conn.id,
          title: `Signed out of Telegram channel @${conn.handle ?? "(unknown)"}`,
          description: "Operator-triggered sign-out.",
        });
      } catch (err) {
        console.error("[telegram/sign-out] activity log failed", err);
      }
    }

    try {
      await setAccountConnectionStatus({
        workspaceId: membership.workspace.id,
        accountId: identityId,
        connectionStatus: "not_connected",
      });
    } catch (err) {
      console.error(
        "[telegram/sign-out] growth_accounts mirror failed",
        err,
      );
    }

    return NextResponse.json({
      ok: true,
      platform: "telegram",
      identity_id: identityId,
      message: "Signed out of this channel.",
    });
  } catch (err) {
    console.error("[telegram/sign-out] unexpected error", err);
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
