"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createOperatorToken,
  revokeOperatorToken,
} from "@/repositories/mcp-server/operator-token-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import { ALLOWED_SCOPES, isAllowedScope } from "@/mcp/permissions";
import { mintPlaintextToken } from "@/mcp/auth";

export type CreateTokenResult = ActionResult<{
  tokenId: string;
  plaintext: string;
  tokenPreview: string;
  scopes: string[];
  expiresAt: string | null;
}>;
export type RevokeTokenResult = ActionResult<{ tokenId: string }>;

export async function createOperatorTokenAction(
  _prev: CreateTokenResult,
  formData: FormData,
): Promise<CreateTokenResult> {
  const name = String(formData.get("name") ?? "").trim();
  const expiresAtRaw = String(formData.get("expires_at") ?? "").trim();
  const requestedScopes = formData.getAll("scopes").map((s) => String(s));

  if (!name) return actionFail("Token name is required.");
  if (requestedScopes.length === 0)
    return actionFail("Select at least one scope.");
  const invalid = requestedScopes.filter((s) => !isAllowedScope(s));
  if (invalid.length > 0) {
    return actionFail(`Unknown / blocked scope(s): ${invalid.join(", ")}`);
  }
  const scopes = requestedScopes.filter(isAllowedScope);

  let expiresAt: string | null = null;
  if (expiresAtRaw) {
    const parsed = new Date(expiresAtRaw);
    if (isNaN(parsed.getTime())) {
      return actionFail("Invalid expiry date.");
    }
    expiresAt = parsed.toISOString();
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const plaintext = mintPlaintextToken();
    const { token } = await createOperatorToken(
      {
        workspaceId,
        name,
        scopes,
        expiresAt,
      },
      plaintext,
    );

    try {
      await recordActivity({
        workspaceId,
        eventType: "mcp.operator_token_created",
        entityType: "mcp_operator_token",
        entityId: token.id,
        title: `MCP operator token created: ${token.name}`,
        description: `Scopes: ${scopes.join(", ")}`,
        metadata: { token_preview: token.tokenPreview, scope_count: scopes.length },
      });
    } catch (err) {
      console.error("[mcp-tokens] activity log failed", err);
    }

    revalidatePath("/settings/mcp/tokens");
    revalidatePath("/settings/mcp");
    return actionOk({
      tokenId: token.id,
      plaintext,
      tokenPreview: token.tokenPreview,
      scopes,
      expiresAt,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not create token.",
    );
  }
}

export async function revokeOperatorTokenAction(
  _prev: RevokeTokenResult,
  formData: FormData,
): Promise<RevokeTokenResult> {
  const tokenId = String(formData.get("token_id") ?? "").trim();
  if (!tokenId) return actionFail("Missing token id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;
    const token = await revokeOperatorToken({ workspaceId, tokenId });
    try {
      await recordActivity({
        workspaceId,
        eventType: "mcp.operator_token_revoked",
        entityType: "mcp_operator_token",
        entityId: tokenId,
        title: `MCP operator token revoked: ${token.name}`,
        description: null,
        metadata: { token_preview: token.tokenPreview },
      });
    } catch (err) {
      console.error("[mcp-tokens] activity log failed", err);
    }
    revalidatePath("/settings/mcp/tokens");
    revalidatePath("/settings/mcp");
    return actionOk({ tokenId });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not revoke token.",
    );
  }
}

// Re-export the allowed-scopes list so the client form can render it
// without a separate fetch. (Server-action files only export async
// functions, so we keep this *inside* a server function.)
export async function listAllowedScopes(): Promise<readonly string[]> {
  return ALLOWED_SCOPES;
}
