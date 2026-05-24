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
 * POST /api/identity/:identityId/bluesky/sign-out
 *
 * Sign out of the Bluesky account this identity is currently
 * authenticated as. The session-based auth flow doesn't go through
 * the OAuth disconnect endpoints (Bluesky uses App Password +
 * createSession, not OAuth), so it gets its own identity-scoped
 * sign-out route that:
 *
 *   1. Verifies the caller owns the identity row (auth + workspace
 *      gate).
 *   2. Marks the platform_connections row revoked, clears the
 *      encrypted access/refresh JWT columns, and drops the
 *      handle_mismatch metadata (so a fresh sign-in returns to a
 *      clean state, not stuck "mismatched").
 *   3. Mirrors growth_accounts.connection_status='not_connected'.
 *
 * This route is identity-scoped on purpose: signing out of identity
 * A must NEVER affect identity B, even if both identities are on
 * the same platform. The lookup is keyed by (workspace, account_id,
 * platform) so it can only ever touch the row belonging to the
 * caller's identity.
 *
 * Token plaintext never appears anywhere — the markConnectionStatus
 * call clears the encrypted columns; the route response carries no
 * token-shaped fields.
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

    if (identity.platform !== "bluesky") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts Bluesky identities only; this identity is on "${identity.platform}".`,
      );
    }

    // Workspace + account + platform tuple. If no row exists, the
    // identity was already signed out — idempotent success.
    const conn = await getConnectionForAccount(
      membership.workspace.id,
      identityId,
      "bluesky" as never,
    );

    if (conn) {
      try {
        await markConnectionStatus({
          workspaceId: membership.workspace.id,
          connectionId: conn.id,
          status: "revoked",
          healthStatus: "revoked",
          message: "Operator signed out of this Bluesky account.",
          // Drop any handle_mismatch payload so the next sign-in
          // starts from a clean state, not stuck mismatched. Token
          // columns are cleared automatically by markConnectionStatus
          // when status='revoked'.
          clearMetadataKeys: ["handle_mismatch"],
        });
      } catch (err) {
        console.error("[bluesky/sign-out] markConnectionStatus failed", err);
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
          title: `Signed out of Bluesky as ${conn.handle ?? "(unknown handle)"}`,
          description: "Operator-triggered sign-out.",
        });
      } catch (err) {
        console.error("[bluesky/sign-out] activity log failed", err);
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
        "[bluesky/sign-out] growth_accounts mirror failed",
        err,
      );
    }

    return NextResponse.json({
      ok: true,
      platform: "bluesky",
      identity_id: identityId,
      message: "Signed out of this account.",
    });
  } catch (err) {
    console.error("[bluesky/sign-out] unexpected error", err);
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
