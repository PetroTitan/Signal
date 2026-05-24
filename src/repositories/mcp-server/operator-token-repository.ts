import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type {
  McpOperatorTokenInsert,
  McpOperatorTokenRow,
  McpOperatorTokenUpdate,
} from "@/lib/supabase/types";
import { hashToken, tokenPreview } from "@/mcp/auth";
import { fromPostgres, notAuthenticated, notFound } from "../errors";

export interface OperatorToken {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  name: string;
  tokenPreview: string;
  status: McpOperatorTokenRow["status"];
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  assistantLabel: string | null;
  renamedAt: string | null;
}

function toToken(row: McpOperatorTokenRow): OperatorToken {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    name: row.name,
    tokenPreview: row.token_preview,
    status: row.status,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    assistantLabel: row.assistant_label,
    renamedAt: row.renamed_at,
  };
}

export interface CreateOperatorTokenInput {
  workspaceId: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  assistantLabel: string | null;
}

export interface CreatedOperatorToken {
  token: OperatorToken;
  /** Plaintext token, only present on creation. */
  plaintext: string;
}

export async function createOperatorToken(
  input: CreateOperatorTokenInput,
  plaintext: string,
): Promise<CreatedOperatorToken> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();
  const tokenHash = await hashToken(plaintext);
  const insert: McpOperatorTokenInsert = {
    workspace_id: input.workspaceId,
    created_by: user.id,
    name: input.name,
    token_hash: tokenHash,
    token_preview: tokenPreview(plaintext),
    status: "active",
    scopes: input.scopes,
    expires_at: input.expiresAt,
    assistant_label: input.assistantLabel,
  };
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to create operator token.");
  return {
    token: toToken(data as unknown as McpOperatorTokenRow),
    plaintext,
  };
}

export async function listOperatorTokens(
  workspaceId: string,
): Promise<OperatorToken[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error)
    throw fromPostgres(error, "Failed to list operator tokens.");
  return ((data ?? []) as unknown as McpOperatorTokenRow[]).map(toToken);
}

export async function getOperatorTokenById(input: {
  workspaceId: string;
  tokenId: string;
}): Promise<OperatorToken> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.tokenId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load operator token.");
  if (!data) throw notFound("Operator token");
  return toToken(data as unknown as McpOperatorTokenRow);
}

export async function renameOperatorToken(input: {
  workspaceId: string;
  tokenId: string;
  name: string;
}): Promise<OperatorToken> {
  const supabase = createSupabaseServerClient();
  const patch: McpOperatorTokenUpdate = {
    name: input.name,
    renamed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.tokenId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to rename operator token.");
  return toToken(data as unknown as McpOperatorTokenRow);
}

export async function revokeOperatorToken(input: {
  workspaceId: string;
  tokenId: string;
}): Promise<OperatorToken> {
  const supabase = createSupabaseServerClient();
  const patch: McpOperatorTokenUpdate = {
    status: "revoked",
    revoked_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.tokenId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to revoke operator token.");
  return toToken(data as unknown as McpOperatorTokenRow);
}

/**
 * Token lookup for the /api/mcp endpoint.
 *
 * This call cannot use the authenticated Supabase session because the
 * caller is an external operator without a Signal session cookie. We
 * fall back to the service-role client purely for this single read of
 * the token row.
 *
 * Once the row is loaded, every downstream call still respects RLS —
 * but importantly, the dispatcher operates as the workspace itself by
 * scoping all subsequent queries to the token's workspace_id via the
 * service-role client. To keep the safety boundary intact, the
 * dispatcher only invokes a narrow set of audited operations on this
 * client; arbitrary writes are not exposed.
 */
export async function lookupTokenByHash(
  tokenHash: string,
): Promise<OperatorToken | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("mcp_operator_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !data) return null;
  return toToken(data as unknown as McpOperatorTokenRow);
}

export async function touchTokenLastUsed(input: {
  workspaceId: string;
  tokenId: string;
}): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  await supabase
    .from("mcp_operator_tokens")
    .update({
      last_used_at: new Date().toISOString(),
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.tokenId);
}
