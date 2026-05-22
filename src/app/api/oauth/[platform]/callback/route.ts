import { NextResponse } from "next/server";
import {
  OAuthError,
  isStateExpired,
  resolveTokenCipher,
  composeTokenPersistence,
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
import { recordActivity } from "@/repositories/activity-repository";

/**
 * GET /api/oauth/:platform/callback
 *
 * Verifies the state, exchanges the code for a token (only if the
 * provider env is configured AND the token cipher is available),
 * and records the connection. If encryption is not configured, the
 * connection is recorded as `error` with metadata explaining why —
 * we never store plaintext tokens.
 *
 * Phase E3 does not actually call the provider's token endpoint
 * over the network. The code path that would exchange `code` for
 * tokens lives behind the cipher availability check and is fenced
 * off in this build. The route is wired so a future PR can drop in
 * the fetch call and have the rest work end-to-end.
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
      throw new OAuthError("provider_not_configured", "OAuth app not configured yet.", 400);
    }

    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (providerError) {
      throw new OAuthError("provider_denied", `Provider returned: ${providerError}`, 400);
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

    // ── Token exchange placeholder. ────────────────────────────────
    // Phase E3 does not invoke the provider's token endpoint. The
    // cipher is the gate: when it is unavailable, we record an
    // `error` connection so the operator can see exactly why the
    // flow stopped. When the cipher and the network exchange both
    // ship in a later phase, replace this branch with the fetch
    // call and feed the response into composeTokenPersistence.
    const cipher = resolveTokenCipher();
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
      try {
        await recordActivity({
          workspaceId: stateRow.workspace_id,
          eventType: "platform_connection.failed",
          entityType: "platform_connection",
          entityId: conn.id,
          title: `${platform} OAuth callback received; tokens not stored`,
          description:
            "Token encryption is not configured. No real tokens were stored.",
        });
      } catch (err) {
        console.error("[oauth/callback] activity log failed", err);
      }
      const target = safeRedirect(stateRow.redirect_after, url.origin);
      const redirectUrl = new URL(target);
      redirectUrl.searchParams.set("oauth", "not_configured");
      return NextResponse.redirect(redirectUrl.toString());
    }

    // When the cipher ships, the token exchange would go here.
    // composeTokenPersistence enforces the no-plaintext rule on
    // persistence so even this future branch cannot silently store
    // an unencrypted value.
    const persisted = composeTokenPersistence({
      platform,
      response: {
        accessToken: "DRY_RUN_REAL_VALUE_NEVER_LOGGED",
        refreshToken: null,
        expiresInSeconds: null,
        scopes: [],
      },
      cipher,
    });
    if (!persisted.ok) {
      throw new OAuthError("token_storage_unavailable", persisted.reason ?? "Token storage refused.", 500);
    }
    // Unreachable in Phase E3 because cipher.isAvailable() is false,
    // but kept here so the future wiring already compiles.
    const conn = await upsertPlatformConnection({
      workspaceId: stateRow.workspace_id,
      accountId: stateRow.account_id ?? null,
      platform,
      providerAccountId: null,
      handle: null,
      displayName: null,
      scopes: [],
      accessTokenEncrypted: persisted.accessTokenEncrypted,
      refreshTokenEncrypted: persisted.refreshTokenEncrypted,
      expiresAt: persisted.expiresAt,
      connectionStatus: "connected",
      metadata: { token_storage: cipher.describe() },
    });
    try {
      await recordActivity({
        workspaceId: stateRow.workspace_id,
        eventType: "platform_connection.connected",
        entityType: "platform_connection",
        entityId: conn.id,
        title: `${platform} connected`,
        description: null,
      });
    } catch (err) {
      console.error("[oauth/callback] activity log failed", err);
    }
    const target = safeRedirect(stateRow.redirect_after, url.origin);
    return NextResponse.redirect(target);
  } catch (err) {
    return oauthJsonError(err);
  }
}
