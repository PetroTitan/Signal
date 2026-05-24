"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createOperatorToken,
  renameOperatorToken,
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
import {
  FOUNDER_PERMISSION_GROUPS,
  resolveScopesFromGroups,
} from "@/mcp/founder-permissions";
import { mintPlaintextToken } from "@/mcp/auth";

export type CreateTokenResult = ActionResult<{
  tokenId: string;
  plaintext: string;
  tokenPreview: string;
  scopes: string[];
  expiresAt: string | null;
  assistantLabel: string | null;
}>;
export type RevokeTokenResult = ActionResult<{ tokenId: string }>;
export type RenameTokenResult = ActionResult<{ tokenId: string; name: string }>;

const ALLOWED_ASSISTANT_LABELS = new Set([
  "Claude Code",
  "Codex",
  "Claude Opus",
  "Custom",
]);

const DURATION_OPTIONS: Record<string, number | null> = {
  "30d": 30,
  "90d": 90,
  never: null,
};

export async function createOperatorTokenAction(
  _prev: CreateTokenResult,
  formData: FormData,
): Promise<CreateTokenResult> {
  const name = String(formData.get("name") ?? "").trim();
  const assistantLabelRaw = String(formData.get("assistant_label") ?? "").trim();
  const expirationKey = String(formData.get("expiration") ?? "").trim();
  const groupKeys = formData.getAll("permission_groups").map((s) => String(s));

  if (!name) return actionFail("Give this token a name.");
  if (!ALLOWED_ASSISTANT_LABELS.has(assistantLabelRaw)) {
    return actionFail(
      "Pick an assistant type (Claude Code, Codex, Claude Opus, or Custom).",
    );
  }
  if (groupKeys.length === 0) {
    return actionFail("Pick at least one permission group.");
  }

  // Resolve founder-readable groups → underlying scopes.
  const scopes = resolveScopesFromGroups(groupKeys);
  if (scopes.length === 0) {
    return actionFail(
      "None of the selected permission groups resolved to a usable scope.",
    );
  }
  const invalid = scopes.filter((s) => !isAllowedScope(s));
  if (invalid.length > 0) {
    // Defensive — `resolveScopesFromGroups` already filters, but
    // double-check before we mint anything.
    return actionFail(`Internal: blocked scope leaked: ${invalid.join(", ")}`);
  }

  let expiresAt: string | null = null;
  if (Object.prototype.hasOwnProperty.call(DURATION_OPTIONS, expirationKey)) {
    const days = DURATION_OPTIONS[expirationKey];
    if (days !== null) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      expiresAt = d.toISOString();
    }
  } else {
    return actionFail("Pick an expiration (30 days / 90 days / Never).");
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
        assistantLabel: assistantLabelRaw,
      },
      plaintext,
    );

    try {
      await recordActivity({
        workspaceId,
        eventType: "mcp.operator_token_created",
        entityType: "mcp_operator_token",
        entityId: token.id,
        title: `MCP token created: ${token.name}`,
        description: `${assistantLabelRaw} · ${scopes.length} permission${scopes.length === 1 ? "" : "s"}`,
        metadata: {
          token_preview: token.tokenPreview,
          assistant_label: assistantLabelRaw,
          scope_count: scopes.length,
          permission_groups: groupKeys,
        },
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
      assistantLabel: assistantLabelRaw,
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
  if (!tokenId) return actionFail("Missing token.");
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
        title: `MCP token revoked: ${token.name}`,
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

export async function renameOperatorTokenAction(
  _prev: RenameTokenResult,
  formData: FormData,
): Promise<RenameTokenResult> {
  const tokenId = String(formData.get("token_id") ?? "").trim();
  const nameRaw = String(formData.get("name") ?? "").trim();
  if (!tokenId) return actionFail("Missing token.");
  if (nameRaw.length === 0) return actionFail("Give the token a name.");
  if (nameRaw.length > 200) {
    return actionFail("Keep the name under 200 characters.");
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;
    const token = await renameOperatorToken({
      workspaceId,
      tokenId,
      name: nameRaw,
    });
    revalidatePath("/settings/mcp/tokens");
    revalidatePath("/settings/mcp");
    return actionOk({ tokenId: token.id, name: token.name });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Could not rename token.",
    );
  }
}

// Re-export the allowed-scopes list for the legacy form path.
export async function listAllowedScopes(): Promise<readonly string[]> {
  return ALLOWED_SCOPES;
}

// Re-export the founder-readable groups for client forms.
export async function listFounderPermissionGroups() {
  return FOUNDER_PERMISSION_GROUPS;
}
