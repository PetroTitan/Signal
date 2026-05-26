import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";

/**
 * POST /api/identity/:identityId/hashnode/publication
 *
 * Body: { publication_id: string }
 *
 * Per-identity Hashnode publication target. The verifier already
 * proves API-key ownership, but Hashnode's free GraphQL tier was
 * retired on 2026-05-13, so the verifier can't auto-discover
 * publications for most accounts. The operator pastes the
 * publication id from their Hashnode dashboard
 * (https://hashnode.com/<publication>/dashboard → Publication Settings
 * → "Publication ID") and we persist it in the connection's
 * metadata.publication_id. The scheduler reads this at publish time.
 *
 * Why this lives on platform_connections.metadata rather than a new
 * column: no schema migration, identity-scoped, and the
 * (workspace, account, "hashnode") row already exists when this
 * route is called (the operator just connected the API key).
 *
 * Authorization: requires authenticated session + primary workspace
 * membership. The identity must be on platform="hashnode".
 *
 * Safety:
 *   - publication_id is opaque + visible by design in Hashnode's UI;
 *     not treated as secret.
 *   - We never look at, store, or echo the API key on this route.
 *   - Updates are scoped to (workspace, account, "hashnode") so a
 *     different operator can't smear publication ids across
 *     identities.
 */

const PUBLICATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

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

    let body: { publication_id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "invalid_body", "Request body must be JSON.");
    }

    const publicationId =
      typeof body.publication_id === "string"
        ? body.publication_id.trim()
        : "";
    if (!publicationId) {
      return jsonError(
        400,
        "publication_id_required",
        "publication_id is required.",
      );
    }
    if (!PUBLICATION_ID_RE.test(publicationId)) {
      return jsonError(
        400,
        "publication_id_invalid",
        "publication_id must be 6-128 chars of [A-Za-z0-9_-].",
      );
    }

    const conn = await getConnectionForAccount(
      membership.workspace.id,
      identityId,
      "hashnode" as never,
    );
    if (!conn) {
      return jsonError(
        404,
        "connection_not_found",
        "Connect the Hashnode API key first, then set the publication id.",
      );
    }

    // Read-modify-write so we don't clobber existing metadata keys
    // (verification_method, token_storage, last_message, etc.).
    const merged: Record<string, unknown> = {
      ...(conn.metadata ?? {}),
      publication_id: publicationId,
      publication_set_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("platform_connections")
      .update({ metadata: merged } as never)
      .eq("workspace_id", membership.workspace.id)
      .eq("id", conn.id);
    if (error) {
      console.error("[hashnode/publication] update failed", error);
      return jsonError(
        500,
        "persist_failed",
        "Could not persist publication id.",
      );
    }

    return NextResponse.json({
      ok: true,
      platform: "hashnode",
      identity_id: identityId,
      publication_id: publicationId,
    });
  } catch (err) {
    console.error("[hashnode/publication] unexpected error", err);
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
