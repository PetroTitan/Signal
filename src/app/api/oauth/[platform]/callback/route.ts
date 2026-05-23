import { NextResponse } from "next/server";
import {
  OAuthError,
  encryptTokenResponse,
  exchangeCodeForToken,
  fetchMe,
  getTokenCipher,
  isStateExpired,
} from "@/core/platform-oauth";
import { readOAuthProviderRuntime } from "@/lib/oauth/env";
import {
  oauthJsonError,
  safeRedirect,
  validatePlatformParam,
} from "../../_helpers";
import {
  consumeOAuthState,
  upsertPlatformConnection,
} from "@/repositories/platform-connection-repository";
import { setAccountConnectionStatus } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * GET /api/oauth/:platform/callback
 *
 * Phase F2 — completes the OAuth handshake:
 *   1. Validate state (one-shot, deleted on read by consumeOAuthState).
 *   2. Exchange `code` for tokens via Reddit's token endpoint.
 *   3. Encrypt tokens with TOKEN_ENCRYPTION_KEY (AES-256-GCM).
 *   4. Fetch /api/v1/me to record handle + provider_account_id.
 *   5. Upsert platform_connections, mirror growth_accounts.
 *
 * Every failure path records a `platform_connection.failed` activity
 * event and routes back to `/accounts` with a query string the UI
 * can render. No tokens are ever logged or persisted in plaintext.
 */
export async function GET(
  request: Request,
  { params }: { params: { platform: string } },
) {
  const url = new URL(request.url);
  try {
    const platform = validatePlatformParam(params.platform);
    const runtime = readOAuthProviderRuntime(platform);
    if (!runtime) {
      throw new OAuthError(
        "provider_not_configured",
        "OAuth app not configured yet.",
        400,
      );
    }

    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (providerError) {
      throw new OAuthError(
        "provider_denied",
        `Provider returned: ${providerError}`,
        400,
      );
    }
    if (!stateParam) {
      throw new OAuthError("state_missing", "Missing OAuth state.", 400);
    }
    if (!code) {
      throw new OAuthError("provider_error", "Provider did not return a code.", 400);
    }

    const stateRow = await consumeOAuthState(stateParam);
    if (!stateRow) {
      throw new OAuthError("state_mismatch", "Unknown OAuth state.", 400);
    }
    if (stateRow.platform !== platform) {
      throw new OAuthError("state_mismatch", "OAuth state platform mismatch.", 400);
    }
    if (isStateExpired(stateRow.expires_at)) {
      throw new OAuthError("state_expired", "OAuth state expired.", 400);
    }

    // ── Gate 1: cipher must be available *before* we ask the provider
    //    for a token. No point holding a real plaintext token if we
    //    can't encrypt it.
    const cipher = getTokenCipher();
    if (!cipher.isAvailable()) {
      const conn = await upsertPlatformConnection({
        workspaceId: stateRow.workspace_id,
        accountId: stateRow.account_id ?? null,
        platform,
        providerAccountId: null,
        handle: null,
        displayName: null,
        scopes: [],
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        expiresAt: null,
        connectionStatus: "error",
        metadata: {
          last_message:
            "OAuth callback received but token encryption is not configured. " +
            "No real tokens were stored. Set TOKEN_ENCRYPTION_KEY and re-run the flow.",
          token_storage: "not_configured",
        },
      });
      await safeRecordActivity({
        workspaceId: stateRow.workspace_id,
        connectionId: conn.id,
        type: "platform_connection.failed",
        title: `${platform} OAuth callback received; tokens not stored`,
        description: "Token encryption is not configured.",
      });
      const redirectUrl = new URL(
        safeRedirect(stateRow.redirect_after, url.origin),
      );
      redirectUrl.searchParams.set("oauth", "not_configured");
      return NextResponse.redirect(redirectUrl.toString());
    }

    // ── Gate 2: exchange code → tokens.
    if (platform !== "reddit") {
      // F2 only ships Reddit live exchange. X / LinkedIn keep the
      // "not implemented" error path.
      throw new OAuthError(
        "provider_not_configured",
        `${platform} OAuth callback is not implemented in F2.`,
        501,
      );
    }
    const tokenResult = await exchangeCodeForToken({ runtime, code });
    if (!tokenResult.ok) {
      const conn = await upsertPlatformConnection({
        workspaceId: stateRow.workspace_id,
        accountId: stateRow.account_id ?? null,
        platform,
        providerAccountId: null,
        handle: null,
        displayName: null,
        scopes: [],
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        expiresAt: null,
        connectionStatus: "error",
        metadata: {
          last_message: `Token exchange failed: ${tokenResult.code} (http ${tokenResult.httpStatus}).`,
          token_exchange_code: tokenResult.code,
          token_exchange_status: tokenResult.httpStatus,
        },
      });
      await safeRecordActivity({
        workspaceId: stateRow.workspace_id,
        connectionId: conn.id,
        type: "platform_connection.failed",
        title: `${platform} token exchange failed`,
        description: `${tokenResult.code} (http ${tokenResult.httpStatus})`,
      });
      const redirectUrl = new URL(
        safeRedirect(stateRow.redirect_after, url.origin),
      );
      redirectUrl.searchParams.set("oauth", "exchange_failed");
      return NextResponse.redirect(redirectUrl.toString());
    }

    const tokens = tokenResult.data;
    const scopes = tokens.scope
      ? tokens.scope.split(/[\s,]+/).filter(Boolean)
      : [];

    // ── Gate 3: encrypt before any other persistence step.
    const enc = encryptTokenResponse({
      platform,
      response: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresInSeconds: tokens.expires_in,
        scopes,
      },
    });
    if (!enc.ok) {
      const conn = await upsertPlatformConnection({
        workspaceId: stateRow.workspace_id,
        accountId: stateRow.account_id ?? null,
        platform,
        providerAccountId: null,
        handle: null,
        displayName: null,
        scopes: [],
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        expiresAt: null,
        connectionStatus: "error",
        metadata: {
          last_message: `Token encryption refused: ${enc.reason}`,
          token_storage: "refused",
        },
      });
      await safeRecordActivity({
        workspaceId: stateRow.workspace_id,
        connectionId: conn.id,
        type: "platform_connection.failed",
        title: `${platform} token encryption refused`,
        description: enc.reason,
      });
      const redirectUrl = new URL(
        safeRedirect(stateRow.redirect_after, url.origin),
      );
      redirectUrl.searchParams.set("oauth", "encryption_refused");
      return NextResponse.redirect(redirectUrl.toString());
    }

    // ── Gate 4: confirm the token works and harvest handle.
    const meResult = await fetchMe({ accessToken: tokens.access_token });
    if (!meResult.ok) {
      const conn = await upsertPlatformConnection({
        workspaceId: stateRow.workspace_id,
        accountId: stateRow.account_id ?? null,
        platform,
        providerAccountId: null,
        handle: null,
        displayName: null,
        scopes,
        accessTokenEncrypted: enc.accessTokenEncrypted,
        refreshTokenEncrypted: enc.refreshTokenEncrypted,
        expiresAt: enc.expiresAt,
        connectionStatus: "error",
        metadata: {
          last_message: `Profile fetch failed: ${meResult.code} (http ${meResult.httpStatus}).`,
          profile_fetch_code: meResult.code,
        },
      });
      await safeRecordActivity({
        workspaceId: stateRow.workspace_id,
        connectionId: conn.id,
        type: "platform_connection.failed",
        title: `${platform} profile fetch failed`,
        description: `${meResult.code} (http ${meResult.httpStatus})`,
      });
      const redirectUrl = new URL(
        safeRedirect(stateRow.redirect_after, url.origin),
      );
      redirectUrl.searchParams.set("oauth", "profile_failed");
      return NextResponse.redirect(redirectUrl.toString());
    }

    // ── Success path: persist connection + mirror growth_accounts.
    const conn = await upsertPlatformConnection({
      workspaceId: stateRow.workspace_id,
      accountId: stateRow.account_id ?? null,
      platform,
      providerAccountId: meResult.data.id,
      handle: meResult.data.name,
      displayName: meResult.data.name,
      scopes,
      accessTokenEncrypted: enc.accessTokenEncrypted,
      refreshTokenEncrypted: enc.refreshTokenEncrypted,
      expiresAt: enc.expiresAt,
      connectionStatus: "connected",
      metadata: {
        token_storage: cipher.describe(),
        last_message: `Connected as u/${meResult.data.name}.`,
      },
    });

    if (stateRow.account_id) {
      try {
        await setAccountConnectionStatus({
          workspaceId: stateRow.workspace_id,
          accountId: stateRow.account_id,
          connectionStatus: "connected",
        });
      } catch (err) {
        console.error("[oauth/callback] growth_accounts update failed", err);
      }
    }

    await safeRecordActivity({
      workspaceId: stateRow.workspace_id,
      connectionId: conn.id,
      type: "platform_connection.connected",
      title: `${platform} connected as u/${meResult.data.name}`,
      description: scopes.length > 0 ? `Scopes: ${scopes.join(", ")}` : null,
    });

    const target = safeRedirect(stateRow.redirect_after, url.origin);
    const redirectUrl = new URL(target);
    redirectUrl.searchParams.set("oauth", "connected");
    return NextResponse.redirect(redirectUrl.toString());
  } catch (err) {
    return oauthJsonError(err);
  }
}

async function safeRecordActivity(input: {
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
    console.error("[oauth/callback] activity log failed", err);
  }
}
