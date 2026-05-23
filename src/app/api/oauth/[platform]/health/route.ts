import { NextResponse } from "next/server";
import {
  decryptForOutboundUse,
  encryptTokenResponse,
  fetchMe,
  getTokenCipher,
  refreshAccessToken,
} from "@/core/platform-oauth";
import { readOAuthProviderRuntime } from "@/lib/oauth/env";
import {
  oauthJsonError,
  resolveAuthenticatedContext,
} from "../../_helpers";
import {
  getConnectionForAccount,
  markConnectionStatus,
  readEncryptedTokens,
  rotateAccessToken,
} from "@/repositories/platform-connection-repository";
import { setAccountConnectionStatus } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * POST /api/oauth/:platform/health
 *
 * Body: { account_id: string }
 *
 * Phase F2 — calls the provider's profile endpoint to confirm the
 * stored token still works.
 *
 * Sequence:
 *   1. Decrypt access token; if missing → expired/reauthorization_required.
 *   2. Call /api/v1/me with bearer.
 *   3. On 200: mark healthy, update last_checked_at.
 *   4. On 401 + we have refresh token: refresh and retry once.
 *   5. On 401 + no refresh: reauthorization_required + expired.
 *   6. On other failures: degraded (transient) or error (persistent).
 *
 * Token plaintexts are held in scope for the duration of the request
 * only — never logged, never returned in the JSON body.
 */
export async function POST(
  request: Request,
  { params }: { params: { platform: string } },
) {
  try {
    const ctx = await resolveAuthenticatedContext(params.platform);
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const accountId =
      typeof body.account_id === "string" ? body.account_id : null;
    if (!accountId) {
      return NextResponse.json(
        { ok: false, code: "validation_failed", error: "account_id is required." },
        { status: 400 },
      );
    }

    const conn = await getConnectionForAccount(
      ctx.workspaceId,
      accountId,
      ctx.platform,
    );
    if (!conn) {
      return NextResponse.json(
        { ok: false, code: "not_found", error: "Connection not found." },
        { status: 404 },
      );
    }

    // F2 only ships Reddit live health. Other platforms fall back to
    // the local-only evaluation by returning `unknown`.
    if (ctx.platform !== "reddit") {
      return NextResponse.json({
        ok: true,
        connectionId: conn.id,
        health: "unknown",
        message: `${ctx.platform} live health-check is not implemented in F2.`,
      });
    }

    const cipher = getTokenCipher();
    if (!cipher.isAvailable()) {
      const updated = await markConnectionStatus({
        workspaceId: ctx.workspaceId,
        connectionId: conn.id,
        status: "error",
        healthStatus: "unknown",
        message: "Token encryption is not configured.",
      });
      return NextResponse.json({
        ok: false,
        connectionId: updated.id,
        health: "unknown",
        code: "token_storage_unavailable",
      });
    }

    const enc = await readEncryptedTokens(ctx.workspaceId, conn.id);
    const accessPlain = enc
      ? decryptForOutboundUse(enc.accessTokenEncrypted)
      : null;
    if (!accessPlain) {
      const updated = await markConnectionStatus({
        workspaceId: ctx.workspaceId,
        connectionId: conn.id,
        status: "reauthorization_required",
        healthStatus: "expired",
        message: "No decryptable access token. Reauthorize the connection.",
      });
      await safeRecord({
        workspaceId: ctx.workspaceId,
        connectionId: updated.id,
        type: "platform_connection.health_checked",
        title: `${ctx.platform} health: expired`,
        description: "No decryptable access token.",
      });
      return NextResponse.json({
        ok: false,
        connectionId: updated.id,
        health: "expired",
        code: "no_access_token",
      });
    }

    let me = await fetchMe({ accessToken: accessPlain });
    let refreshedScopes: string[] | null = null;
    if (
      !me.ok &&
      me.code === "oauth_expired" &&
      enc?.refreshTokenEncrypted
    ) {
      const runtime = readOAuthProviderRuntime("reddit");
      const refreshPlain = decryptForOutboundUse(enc.refreshTokenEncrypted);
      if (runtime && refreshPlain) {
        const refreshed = await refreshAccessToken({
          runtime,
          refreshToken: refreshPlain,
        });
        if (refreshed.ok) {
          const tokens = refreshed.data;
          const scopes = tokens.scope
            ? tokens.scope.split(/[\s,]+/).filter(Boolean)
            : conn.scopes;
          const encNew = encryptTokenResponse({
            platform: "reddit",
            response: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token ?? null,
              expiresInSeconds: tokens.expires_in,
              scopes,
            },
          });
          if (encNew.ok) {
            await rotateAccessToken({
              workspaceId: ctx.workspaceId,
              connectionId: conn.id,
              accessTokenEncrypted: encNew.accessTokenEncrypted,
              refreshTokenEncrypted:
                encNew.refreshTokenEncrypted ?? enc.refreshTokenEncrypted,
              expiresAt: encNew.expiresAt,
              scopes,
            });
            refreshedScopes = scopes;
            me = await fetchMe({ accessToken: tokens.access_token });
          }
        }
      }
    }

    if (!me.ok) {
      // Persistent failure → mark expired or reauthorization_required.
      const transient =
        me.code === "rate_limited" || me.code === "provider_5xx" || me.code === "network_error";
      const updated = await markConnectionStatus({
        workspaceId: ctx.workspaceId,
        connectionId: conn.id,
        status: transient
          ? conn.connectionStatus
          : me.code === "oauth_expired"
            ? "reauthorization_required"
            : "error",
        healthStatus: transient
          ? "degraded"
          : me.code === "oauth_expired"
            ? "expired"
            : "unknown",
        message: `Profile fetch failed: ${me.code} (http ${me.httpStatus}).`,
      });
      if (!transient && me.code === "oauth_expired" && accountId) {
        try {
          await setAccountConnectionStatus({
            workspaceId: ctx.workspaceId,
            accountId,
            connectionStatus: "reauthorization_required",
          });
        } catch (err) {
          console.error("[oauth/health] growth_accounts update failed", err);
        }
      }
      await safeRecord({
        workspaceId: ctx.workspaceId,
        connectionId: updated.id,
        type: "platform_connection.health_checked",
        title: `${ctx.platform} health: ${updated.healthStatus}`,
        description: `${me.code} (http ${me.httpStatus})`,
      });
      return NextResponse.json({
        ok: false,
        connectionId: updated.id,
        health: updated.healthStatus,
        connectionStatus: updated.connectionStatus,
        code: me.code,
      });
    }

    const updated = await markConnectionStatus({
      workspaceId: ctx.workspaceId,
      connectionId: conn.id,
      status: "connected",
      healthStatus: "healthy",
      message: refreshedScopes
        ? `Healthy. Access token refreshed; scopes: ${refreshedScopes.join(", ")}.`
        : `Healthy. Connected as u/${me.data.name}.`,
    });
    if (accountId) {
      try {
        await setAccountConnectionStatus({
          workspaceId: ctx.workspaceId,
          accountId,
          connectionStatus: "connected",
        });
      } catch (err) {
        console.error("[oauth/health] growth_accounts update failed", err);
      }
    }
    await safeRecord({
      workspaceId: ctx.workspaceId,
      connectionId: updated.id,
      type: "platform_connection.health_checked",
      title: `${ctx.platform} health: healthy`,
      description: refreshedScopes ? "Access token refreshed." : null,
    });
    return NextResponse.json({
      ok: true,
      connectionId: updated.id,
      health: "healthy",
      handle: me.data.name,
      providerAccountId: me.data.id,
      refreshed: refreshedScopes !== null,
    });
  } catch (err) {
    return oauthJsonError(err);
  }
}

async function safeRecord(input: {
  workspaceId: string;
  connectionId: string;
  type: string;
  title: string;
  description: string | null;
}): Promise<void> {
  try {
    await recordActivity({
      workspaceId: input.workspaceId,
      eventType: input.type,
      entityType: "platform_connection",
      entityId: input.connectionId,
      title: input.title,
      description: input.description,
    });
  } catch (err) {
    console.error("[oauth/health] activity log failed", err);
  }
}
