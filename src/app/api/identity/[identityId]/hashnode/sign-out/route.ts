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
 * POST /api/identity/:identityId/hashnode/sign-out
 *
 * Identity-scoped sign-out for Hashnode. Mirrors the dev.to /
 * Bluesky sign-out pattern: revoke the encrypted API key + clear
 * handle_mismatch metadata + mirror
 * growth_accounts.connection_status="not_connected". Idempotent;
 * affects only THIS identity's row.
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

    if (identity.platform !== "hashnode") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts Hashnode identities only; this identity is on "${identity.platform}".`,
      );
    }

    const conn = await getConnectionForAccount(
      membership.workspace.id,
      identityId,
      "hashnode" as never,
    );

    if (conn) {
      try {
        await markConnectionStatus({
          workspaceId: membership.workspace.id,
          connectionId: conn.id,
          status: "revoked",
          healthStatus: "revoked",
          message: "Operator signed out of this Hashnode account.",
          clearMetadataKeys: ["handle_mismatch"],
        });
      } catch (err) {
        console.error(
          "[hashnode/sign-out] markConnectionStatus failed",
          err,
        );
        return jsonError(
          500,
          "sign_out_failed",
          "Could not sign out of this account.",
        );
      }
      try {
        await recordActivity({
          workspaceId: membership.workspace.id,
          eventType: "platform_connection.disconnected",
          entityType: "platform_connection",
          entityId: conn.id,
          title: `Signed out of Hashnode as ${conn.handle ?? "(unknown username)"}`,
          description: "Operator-triggered sign-out.",
        });
      } catch (err) {
        console.error("[hashnode/sign-out] activity log failed", err);
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
        "[hashnode/sign-out] growth_accounts mirror failed",
        err,
      );
    }

    return NextResponse.json({
      ok: true,
      platform: "hashnode",
      identity_id: identityId,
      message: "Signed out of this account.",
    });
  } catch (err) {
    console.error("[hashnode/sign-out] unexpected error", err);
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
