import { NextResponse } from "next/server";
import {
  decryptForOutboundUse,
  getTokenCipher,
  revokeToken,
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
} from "@/repositories/platform-connection-repository";
import { setAccountConnectionStatus } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * POST /api/oauth/:platform/disconnect
 *
 * Body: { account_id: string }
 *
 * Phase F2:
 *   1. Look up the connection.
 *   2. If we hold an encrypted token AND the platform supports
 *      revocation: call the provider's revoke endpoint (best-effort).
 *   3. Mark connection_status='revoked', clear encrypted columns,
 *      set health_status='revoked'.
 *   4. Mirror growth_accounts.connection_status='not_connected'.
 *   5. Record activity.
 *
 * Token values never appear in logs or response bodies.
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

    // Best-effort: revoke at the provider before we wipe the local
    // copy. If the network call fails we still proceed — the local
    // record being cleared is what matters for safety.
    let revokeOutcome: { httpStatus: number; ok: boolean; detail: string | null } =
      { ok: false, httpStatus: 0, detail: "not_attempted" };
    const runtime = readOAuthProviderRuntime(ctx.platform);
    const cipher = getTokenCipher();
    if (
      runtime &&
      cipher.isAvailable() &&
      ctx.platform === "reddit" &&
      conn.hasAccessToken
    ) {
      const enc = await readEncryptedTokens(ctx.workspaceId, conn.id);
      const accessPlain = enc
        ? decryptForOutboundUse(enc.accessTokenEncrypted)
        : null;
      const refreshPlain = enc?.refreshTokenEncrypted
        ? decryptForOutboundUse(enc.refreshTokenEncrypted)
        : null;
      // Prefer revoking the refresh token (kills both); fall back to
      // the access token if we don't have a refresh token.
      const target = refreshPlain
        ? { token: refreshPlain, tokenTypeHint: "refresh_token" as const }
        : accessPlain
          ? { token: accessPlain, tokenTypeHint: "access_token" as const }
          : null;
      if (target) {
        revokeOutcome = await revokeToken({ runtime, ...target });
      }
    }

    const updated = await markConnectionStatus({
      workspaceId: ctx.workspaceId,
      connectionId: conn.id,
      status: "revoked",
      healthStatus: "revoked",
      message: revokeOutcome.ok
        ? "Operator disconnected; provider revoke accepted."
        : revokeOutcome.detail === "not_attempted"
          ? "Operator disconnected; provider revoke not attempted (no token to revoke)."
          : `Operator disconnected; provider revoke failed (${revokeOutcome.httpStatus}).`,
      // An explicit operator disconnect is a clean reset for the
      // identity. Drop the handle_mismatch marker (if any) so the
      // resolver returns to clean `pending_auth` on the next render
      // instead of leaving the identity stuck in 'mismatched'. The
      // other metadata (token_storage, diagnostic fields) is
      // preserved.
      clearMetadataKeys: ["handle_mismatch"],
    });

    try {
      await setAccountConnectionStatus({
        workspaceId: ctx.workspaceId,
        accountId,
        connectionStatus: "not_connected",
      });
    } catch (err) {
      console.error("[oauth/disconnect] growth_accounts update failed", err);
    }

    try {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "platform_connection.disconnected",
        entityType: "platform_connection",
        entityId: updated.id,
        title: `${ctx.platform} disconnected`,
        description: revokeOutcome.ok
          ? "Provider acknowledged the revoke."
          : null,
      });
    } catch (err) {
      console.error("[oauth/disconnect] activity log failed", err);
    }

    return NextResponse.json({
      ok: true,
      connectionId: updated.id,
      providerRevokeStatus: revokeOutcome.httpStatus,
    });
  } catch (err) {
    return oauthJsonError(err);
  }
}
