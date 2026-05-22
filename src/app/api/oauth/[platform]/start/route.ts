import { NextResponse } from "next/server";
import {
  OAuthError,
  allRequestedScopes,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  getOAuthProvider,
} from "@/core/platform-oauth";
import { readOAuthProviderRuntime } from "@/lib/oauth/env";
import {
  oauthJsonError,
  resolveAuthenticatedContext,
} from "../../_helpers";
import { persistOAuthState } from "@/repositories/platform-connection-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * GET /api/oauth/:platform/start
 *
 * Builds the authorize URL, persists the state token (binds it to
 * user + workspace + platform), and redirects the browser to the
 * provider.
 */
export async function GET(
  request: Request,
  { params }: { params: { platform: string } },
) {
  try {
    const ctx = await resolveAuthenticatedContext(params.platform);
    const runtime = readOAuthProviderRuntime(ctx.platform);
    if (!runtime) {
      throw new OAuthError(
        "provider_not_configured",
        "OAuth app not configured yet.",
        400,
      );
    }
    const provider = getOAuthProvider(ctx.platform);
    const url = new URL(request.url);
    const accountId = url.searchParams.get("account_id");
    const redirectAfter = url.searchParams.get("redirect_after");

    const state = generateState();
    const codeVerifier = provider.pkce ? generateCodeVerifier() : null;
    const codeChallenge = codeVerifier
      ? await deriveCodeChallenge(codeVerifier)
      : null;

    await persistOAuthState({
      state,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      platform: ctx.platform,
      accountId,
      redirectAfter,
      codeVerifier,
    });

    const authorizeUrl = new URL(provider.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", runtime.clientId);
    authorizeUrl.searchParams.set("redirect_uri", runtime.redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set(
      "scope",
      allRequestedScopes(ctx.platform).join(provider.platform === "reddit" ? "," : " "),
    );
    if (provider.platform === "reddit") {
      authorizeUrl.searchParams.set("duration", "permanent");
    }
    if (codeChallenge) {
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
    }

    try {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "platform_connection.started",
        entityType: "platform_connection",
        entityId: accountId,
        title: `OAuth start: ${provider.label}`,
        description: `Redirecting to ${provider.label} for authorization.`,
      });
    } catch (err) {
      console.error("[oauth/start] activity log failed", err);
    }

    return NextResponse.redirect(authorizeUrl.toString());
  } catch (err) {
    return oauthJsonError(err);
  }
}
