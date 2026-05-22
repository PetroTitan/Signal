import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OperatorToken } from "@/repositories/mcp-server/operator-token-repository";

/**
 * Phase F0 — context passed to every tool handler.
 *
 * `db` is the service-role client scoped to the workspace by the
 * tool's own queries (every query MUST .eq('workspace_id', ctx.workspaceId)).
 * The tool registry's permission check has already verified the
 * token's scopes before the handler runs, so handlers can focus on
 * business logic.
 */
export interface ToolContext {
  workspaceId: string;
  operatorTokenId: string;
  scopes: ReadonlyArray<string>;
  token: OperatorToken;
  db: SupabaseClient;
}
