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
  verifyDevtoIdentity,
  buildDevtoVerifyPlan,
} from "@/core/identity-verifiers";

/**
 * POST /api/identity/:identityId/devto/connect
 *
 * Body: { api_key: string }
 *
 * Authenticates a dev.to identity for publishing by verifying the
 * provided API key against GET /api/users/me:
 *
 *   1. Auth + workspace + identity gate (caller must own the row).
 *   2. Identity platform must be "devto".
 *   3. Call dev.to /api/users/me with the provided api-key header.
 *   4. Verify returned username matches the identity's declared
 *      handle.
 *   5. Encrypt the API key server-side with TOKEN_ENCRYPTION_KEY
 *      (AES-256-GCM).
 *   6. Upsert platform_connections with connection_status='connected'.
 *   7. Mirror growth_accounts.connection_status='connected'.
 *
 * Security boundaries:
 *   - The API key is read once from the POST body, passed to the
 *     verifier, encrypted, persisted, and never echoed.
 *   - The HTTP response contains only the username + id — never
 *     the API key.
 *   - On mismatch: write an audit row (connection_status='error',
 *     metadata.handle_mismatch), do NOT persist the key, do NOT
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

    if (identity.platform !== "devto") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts dev.to identities only; this identity is on "${identity.platform}".`,
      );
    }

    // Read the API key from the POST body. It's held in memory only
    // for the duration of this function.
    let body: { api_key?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "invalid_body", "Request body must be JSON.");
    }

    const apiKey =
      typeof body.api_key === "string" ? body.api_key : "";
    if (!apiKey) {
      return jsonError(
        400,
        "credentials_missing",
        "dev.to API key is required.",
      );
    }

    const verifyResult = await verifyDevtoIdentity({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? "",
      apiKey,
    });

    const plan = buildDevtoVerifyPlan({
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
                ? `dev.to signed in as ${plan.upsert.handle}`
                : "dev.to handle mismatch",
            description:
              typeof plan.upsert.metadata?.last_message === "string"
                ? plan.upsert.metadata.last_message
                : null,
          });
        } catch (err) {
          console.error("[devto/connect] activity log failed", err);
        }
      } catch (err) {
        console.error("[devto/connect] upsert failed", err);
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
          "[devto/connect] growth_accounts promote failed",
          err,
        );
      }
    }

    return NextResponse.json(plan.response.body, {
      status: plan.response.status,
    });
  } catch (err) {
    console.error("[devto/connect] unexpected error", err);
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
