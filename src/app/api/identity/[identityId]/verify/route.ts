import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import { resolveBlueskyHandle } from "@/core/identity-verifiers";

/**
 * POST /api/identity/:identityId/verify
 *
 * Per-identity public handle resolution for Bluesky. Resolves the
 * declared handle through AT Protocol's public lookup; does NOT
 * authenticate Signal and does NOT write a connection row. The
 * Bluesky "Check account access" button in the Manage panel uses
 * this endpoint to confirm the handle still maps to a DID without
 * re-prompting the operator for an App Password.
 *
 * Every other platform uses a platform-specific route:
 *   - dev.to     → /api/identity/:id/devto/connect    + /sign-out
 *   - Hashnode   → /api/identity/:id/hashnode/connect + /sign-out
 *   - Telegram   → /api/identity/:id/telegram/verify  + /sign-out
 *   - Bluesky    → /api/identity/:id/bluesky/connect  + /sign-out
 *     (ownership-proving; THIS route is the public resolve only)
 *   - Reddit     → /api/oauth/reddit/start            (OAuth)
 *
 * This route refuses any platform other than Bluesky with a single
 * generic 410 — the Manage panel never reaches it for those
 * platforms; the refusal is defensive in case an old client retains
 * a cached URL.
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
    if (platform !== "bluesky") {
      // Defensive: the Manage panel routes every other platform to
      // its dedicated endpoint and never calls this URL for them.
      // If we reach here, an old cached client (or a manual probe)
      // hit it. Return a generic refusal with no internal terms.
      return NextResponse.json(
        {
          ok: false,
          code: "wrong_endpoint",
          message:
            "Use the Manage panel on the Accounts page to sign in to this account.",
        },
        { status: 410 },
      );
    }

    // Bluesky public handle resolution. Does NOT authenticate Signal
    // and does NOT write a connection row. Ownership-proving sign-in
    // is the responsibility of POST /api/identity/:id/bluesky/connect
    // which takes a Bluesky App Password and runs createSession.
    const resolveResult = await resolveBlueskyHandle({
      identityId,
      workspaceId: membership.workspace.id,
      declaredHandle: identity.handle ?? "",
    });

    if (resolveResult.outcome === "handle_resolved") {
      return NextResponse.json({
        ok: true,
        code: "handle_resolved",
        platform: "bluesky",
        identity_id: identityId,
        declared_handle: identity.handle,
        resolved_handle: resolveResult.authenticatedHandle,
        provider_account_id: resolveResult.providerAccountId,
        message:
          "Handle resolved. Sign in with a Bluesky App Password to give Signal publishing access for this account.",
      });
    }

    if (resolveResult.outcome === "mismatched") {
      return NextResponse.json(
        {
          ok: false,
          code: "handle_mismatch",
          platform: "bluesky",
          identity_id: identityId,
          declared: resolveResult.declaredHandle,
          authenticated: resolveResult.authenticatedHandle,
          provider_account_id: resolveResult.providerAccountId,
          message:
            "This handle now resolves to a different Bluesky account. Update the handle on the identity, or sign in with the correct account.",
        },
        { status: 409 },
      );
    }

    // resolveResult.outcome === "error"
    const status =
      resolveResult.code === "handle_invalid" ||
      resolveResult.code === "handle_not_found"
        ? 400
        : resolveResult.code === "network_error"
          ? 503
          : 502;
    return NextResponse.json(
      {
        ok: false,
        code: resolveResult.code,
        platform: "bluesky",
        identity_id: identityId,
        declared: identity.handle,
        message: resolveResult.message,
      },
      { status },
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
