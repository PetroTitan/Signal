import "server-only";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import {
  OAUTH_ERROR_MESSAGES,
  OAUTH_PLATFORMS,
  OAuthError,
  type OAuthErrorCode,
  type OAuthPlatform,
} from "@/core/platform-oauth";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";

export interface OAuthRouteContext {
  platform: OAuthPlatform;
  workspaceId: string;
  userId: string;
}

export function validatePlatformParam(raw: string | undefined): OAuthPlatform {
  if (!raw || !OAUTH_PLATFORMS.includes(raw as OAuthPlatform)) {
    throw new OAuthError("platform_unsupported", `Unsupported platform "${raw}".`, 404);
  }
  return raw as OAuthPlatform;
}

export async function resolveAuthenticatedContext(
  platformParam: string | undefined,
): Promise<OAuthRouteContext> {
  const platform = validatePlatformParam(platformParam);
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new OAuthError("not_authenticated", OAUTH_ERROR_MESSAGES.not_authenticated, 401);
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    throw new OAuthError("no_workspace", OAUTH_ERROR_MESSAGES.no_workspace, 400);
  }
  return {
    platform,
    workspaceId: membership.workspace.id,
    userId: user.id,
  };
}

export function oauthJsonError(err: unknown): NextResponse {
  if (err instanceof OAuthError) {
    return NextResponse.json(
      { ok: false, code: err.code, error: err.message },
      { status: err.httpStatus },
    );
  }
  const code: OAuthErrorCode = "unknown";
  return NextResponse.json(
    { ok: false, code, error: OAUTH_ERROR_MESSAGES.unknown },
    { status: 500 },
  );
}

export function safeRedirect(target: string | null, origin: string): string {
  if (!target) return `${origin}/accounts`;
  if (!target.startsWith("/")) return `${origin}/accounts`;
  if (target.startsWith("//")) return `${origin}/accounts`;
  return `${origin}${target}`;
}
