import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getAccountById,
  setAccountConnectionStatus,
} from "@/repositories/account-repository";
import {
  PlatformConnectionAttachedToAnotherIdentityError,
  upsertPlatformConnection,
} from "@/repositories/platform-connection-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  connectBlueskyWithAppPassword,
  buildBlueskySessionPlan,
} from "@/core/identity-verifiers";

/**
 * POST /api/identity/:identityId/bluesky/connect
 *
 * Body: { handle: string, app_password: string }
 *
 * Authenticates a Bluesky identity for publishing via the AT
 * Protocol app-password session flow:
 *
 *   1. Auth + workspace + identity gate (caller must own the row).
 *   2. createSession against bsky.social using the App Password.
 *   3. Verify the authenticated DID/handle matches the identity's
 *      declared handle.
 *   4. Encrypt access + refresh JWTs server-side with
 *      TOKEN_ENCRYPTION_KEY (AES-256-GCM).
 *   5. Upsert platform_connections with the encrypted blobs and
 *      connection_status='connected'.
 *   6. Mirror growth_accounts.connection_status='connected'.
 *
 * Security boundaries:
 *   - The App Password is read once from the POST body, passed to
 *     the verifier, and never persisted, logged, or echoed.
 *   - Plaintext JWTs are encrypted before they reach the repository.
 *   - The HTTP response contains the DID + handle only — never the
 *     JWTs, never the password.
 *   - On mismatch: write an audit row (connection_status='error',
 *     metadata.handle_mismatch), do NOT persist tokens, do NOT
 *     promote growth_accounts.
 *   - On auth failure / network error: write nothing.
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

    if (identity.platform !== "bluesky") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts Bluesky identities only; this identity is on "${identity.platform}".`,
      );
    }

    // Parse the body. The password is held only for the duration of
    // this function; nothing further down the stack persists it.
    let body: { handle?: unknown; app_password?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "invalid_body", "Request body must be JSON.");
    }

    const handle = typeof body.handle === "string" ? body.handle : "";
    const appPassword =
      typeof body.app_password === "string" ? body.app_password : "";
    if (!handle.trim()) {
      return jsonError(400, "handle_required", "Handle is required.");
    }
    if (!appPassword) {
      return jsonError(
        400,
        "credentials_missing",
        "Bluesky App Password is required.",
      );
    }

    const sessionResult = await connectBlueskyWithAppPassword({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? handle,
      identifier: handle,
      appPassword,
    });

    const plan = buildBlueskySessionPlan({
      result: sessionResult,
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
                ? `Bluesky connected as ${plan.upsert.handle}`
                : "Bluesky handle mismatch",
            description:
              typeof plan.upsert.metadata?.last_message === "string"
                ? plan.upsert.metadata.last_message
                : null,
          });
        } catch (err) {
          // Activity log failure is not fatal. Note: we deliberately
          // log the error object but the err itself doesn't carry
          // the password (the password never reached this scope as
          // anything other than the now-discarded `appPassword`
          // local).
          console.error("[bluesky/connect] activity log failed", err);
        }
      } catch (err) {
        if (err instanceof PlatformConnectionAttachedToAnotherIdentityError) {
          return jsonError(
            409,
            "attached_to_another_identity",
            "That Bluesky session resolves to an account already attached to another identity in this workspace. Open that identity to manage its connection, or sign out of it before reusing the credentials here.",
          );
        }
        console.error("[bluesky/connect] upsert failed", err);
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
          "[bluesky/connect] growth_accounts promote failed",
          err,
        );
      }
    }

    return NextResponse.json(plan.response.body, {
      status: plan.response.status,
    });
  } catch (err) {
    console.error("[bluesky/connect] unexpected error", err);
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
