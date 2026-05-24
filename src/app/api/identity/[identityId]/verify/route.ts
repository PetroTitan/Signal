import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { isApiKeyVerifyPlatform } from "@/core/publishing/connect-identity";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

/**
 * POST /api/identity/:identityId/verify
 *
 * Identity-level "connect via API-key verify" endpoint. Today it is
 * a STUB that authenticates the caller, validates the identity row
 * exists within the caller's workspace, confirms the platform uses
 * the api_key_verify path, and returns `not_implemented`.
 *
 * The actual per-platform verifiers (Bluesky resolveHandle, dev.to
 * /users/me, Hashnode GraphQL `me { username }`, Telegram getChat)
 * land in follow-up PRs — one per platform — because each needs its
 * own provider client and error model.
 *
 * The route exists now so:
 *   - the UI can render the Verify button without waiting on the
 *     per-platform verifiers
 *   - operators get an honest "not implemented yet" message instead
 *     of a broken click
 *   - the workspace-isolation + identity-lookup gates are already in
 *     place; the verifier PRs only have to fill in the provider call
 *
 * Important security boundaries this stub already enforces:
 *   - caller must be authenticated
 *   - caller's workspace must own the identity row
 *   - platform must be one that uses the api_key_verify path; the
 *     route refuses to act for OAuth platforms (those go through
 *     /api/oauth/:platform/start) or manual/distribution platforms
 *     (those have no auth to perform)
 *   - no token persistence, no SQL writes
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

    // Loads the identity scoped to the caller's workspace; throws on
    // missing-or-out-of-workspace. The catch below maps that to a
    // 404 so we don't leak whether the id exists in another
    // workspace.
    let identity;
    try {
      identity = await getAccountById(membership.workspace.id, identityId);
    } catch {
      return jsonError(404, "identity_not_found", "Identity not found.");
    }

    const platform = identity.platform as FounderPlatform;
    if (!isApiKeyVerifyPlatform(platform)) {
      return jsonError(
        400,
        "platform_not_supported",
        `Platform "${platform}" does not use the API-key verify flow. ` +
          (platform === "reddit"
            ? "Use /api/oauth/reddit/start instead."
            : "This platform has no identity-level connect path."),
      );
    }

    return NextResponse.json(
      {
        ok: false,
        code: "not_implemented",
        platform,
        identity_id: identityId,
        declared_handle: identity.handle,
        message:
          `Identity verification for ${platform} is not implemented yet. ` +
          `The provider client will land in a follow-up PR.`,
      },
      { status: 501 },
    );
  } catch (err) {
    console.error("[identity/verify] unexpected error", err);
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
