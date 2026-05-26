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
  verifyHashnodeIdentity,
  buildHashnodeVerifyPlan,
} from "@/core/identity-verifiers";

/**
 * POST /api/identity/:identityId/hashnode/connect
 *
 * Body: { api_key: string }
 *
 * Authenticates a Hashnode identity by verifying the provided API
 * key against the Hashnode GraphQL `me { username id }` query. Same
 * persistence pattern as the dev.to route: encrypts the key, writes
 * platform_connections, mirrors growth_accounts on success; writes
 * an audit row on mismatch with handle_mismatch metadata; writes
 * nothing on error.
 *
 * The API key is read once from the POST body, passed to the
 * verifier, encrypted, persisted, and never echoed in the response,
 * metadata, logs, or redirect URLs.
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

    if (identity.platform !== "hashnode") {
      return jsonError(
        400,
        "platform_mismatch",
        `Route accepts Hashnode identities only; this identity is on "${identity.platform}".`,
      );
    }

    let body: { api_key?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "invalid_body", "Request body must be JSON.");
    }

    const apiKey = typeof body.api_key === "string" ? body.api_key : "";
    if (!apiKey) {
      return jsonError(
        400,
        "credentials_missing",
        "Hashnode API key is required.",
      );
    }

    const verifyResult = await verifyHashnodeIdentity({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? "",
      apiKey,
    });

    const plan = buildHashnodeVerifyPlan({
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
                ? `Hashnode signed in as ${plan.upsert.handle}`
                : "Hashnode handle mismatch",
            description:
              typeof plan.upsert.metadata?.last_message === "string"
                ? plan.upsert.metadata.last_message
                : null,
          });
        } catch (err) {
          console.error("[hashnode/connect] activity log failed", err);
        }
      } catch (err) {
        if (err instanceof PlatformConnectionAttachedToAnotherIdentityError) {
          return jsonError(
            409,
            "attached_to_another_identity",
            "That Hashnode API key resolves to an account already attached to another identity in this workspace. Open that identity to manage its connection, or sign out of it before reusing the key here.",
          );
        }
        console.error("[hashnode/connect] upsert failed", err);
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
          "[hashnode/connect] growth_accounts promote failed",
          err,
        );
      }
    }

    return NextResponse.json(plan.response.body, {
      status: plan.response.status,
    });
  } catch (err) {
    console.error("[hashnode/connect] unexpected error", err);
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
