import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import { resolveBlueskyHandle } from "@/core/identity-verifiers";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  getSessionInfo,
  isRefreshableAuthFailure,
} from "@/core/bluesky-relationships/atproto-graph";

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

    // ── ACCESS, not existence. ─────────────────────────────────────
    //
    // This used to resolve the public handle and stop there, which
    // answers "does this account exist?" — a question nobody was
    // asking. It reported success against an identity whose access
    // token had expired hours earlier, which is why Accounts kept
    // showing "Signed in" while every follow was being refused.
    //
    // So: exercise the session. If the token has aged out, spend the
    // stored refresh token once — the same one-refresh rule the
    // mutations use — and report honestly if that fails.
    const session = await resolveRelationshipSession({
      workspaceId: membership.workspace.id,
      accountId: identityId,
    });

    if (!session.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "reauthorization_required",
          platform: "bluesky",
          identity_id: identityId,
          declared_handle: identity.handle,
          message: session.message,
        },
        { status: 409 },
      );
    }

    let probe = await getSessionInfo({
      accessJwt: session.accessJwt,
      pds: session.service,
    });

    if (!probe.ok && isRefreshableAuthFailure(probe)) {
      const renewed = await session.refreshOnce();
      if (!renewed.ok) {
        // `refreshOnce` has already marked the connection expired, so
        // the Accounts panel will offer "Sign in again" on reload.
        return NextResponse.json(
          {
            ok: false,
            code: "reauthorization_required",
            platform: "bluesky",
            identity_id: identityId,
            declared_handle: identity.handle,
            message: renewed.message,
          },
          { status: 409 },
        );
      }
      probe = await getSessionInfo({
        accessJwt: renewed.accessJwt,
        pds: renewed.service,
      });
    }

    if (probe.ok) {
      return NextResponse.json({
        ok: true,
        code: probe.active ? "session_valid" : "account_inactive",
        platform: "bluesky",
        identity_id: identityId,
        declared_handle: identity.handle,
        authenticated_handle: probe.handle,
        provider_account_id: probe.did,
        message: probe.active
          ? `Signed in as ${probe.handle ? `@${probe.handle}` : "this account"}. Signal can act as this account.`
          : "Bluesky reports this account as inactive. Signal cannot act as it.",
      });
    }

    if (probe.kind === "auth") {
      return NextResponse.json(
        {
          ok: false,
          code: "reauthorization_required",
          platform: "bluesky",
          identity_id: identityId,
          declared_handle: identity.handle,
          message: probe.message,
        },
        { status: 409 },
      );
    }

    // Not an access problem — the provider is unreachable or unwell.
    // Reported separately so a transient outage is not mistaken for a
    // signed-out account.
    if (probe.kind === "network" || probe.status >= 500) {
      return NextResponse.json(
        {
          ok: false,
          code: "provider_unavailable",
          platform: "bluesky",
          identity_id: identityId,
          message:
            "Bluesky could not be reached, so account access could not be checked. Your sign-in has not changed.",
        },
        { status: 503 },
      );
    }

    // Anything else falls through to the public handle check below,
    // which still distinguishes "handle now points elsewhere".
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
