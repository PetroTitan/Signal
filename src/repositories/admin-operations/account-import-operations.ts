import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  GrowthAccountInsert,
  GrowthAccountRow,
} from "@/lib/supabase/types";
import {
  assertConfirmationOrPending,
  mcpFail,
  mcpOk,
  operationDefaultSource,
  type McpOperationResult,
  type OperationContext,
} from "@/core/mcp-operations";
import { fromPostgres } from "@/repositories/errors";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { logMcpOperation } from "./operation-audit";

export interface AccountImportInput {
  platform: string;
  displayName: string;
  handle?: string | null;
  role?: string | null;
  productId?: string | null;
}

export interface AccountImportPayload {
  accountId: string;
  source: string;
  reviewStatus: "pending_review" | "confirmed";
}

/**
 * Create an account from an MCP-driven screenshot import. Defaults to
 * `review_status = pending_review` unless the user confirmed in the
 * import UI. Connection status remains `not_connected` — OAuth is not
 * touched by MCP operations.
 */
export async function importAccountFromScreenshot(
  input: AccountImportInput,
  ctx: OperationContext,
): Promise<McpOperationResult<AccountImportPayload>> {
  const operationType = "screenshot_account_import" as const;
  const start = Date.now();

  if (!input.platform || !input.displayName) {
    return mcpFail(
      operationType,
      "Platform and display name are required.",
      "validation_failed",
      { durationMs: Date.now() - start },
    );
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return mcpFail(operationType, "Not authenticated.", "not_authenticated", {
      durationMs: Date.now() - start,
    });
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return mcpFail(operationType, "No workspace found.", "not_authorized", {
      durationMs: Date.now() - start,
    });
  }

  const reviewStatus = assertConfirmationOrPending(operationType, ctx);
  const source = operationDefaultSource(operationType);

  const insert: GrowthAccountInsert = {
    workspace_id: membership.workspace.id,
    product_id: input.productId ?? null,
    platform: input.platform,
    handle: input.handle ?? null,
    display_name: input.displayName,
    role: input.role ?? null,
    status: "planned",
    connection_status: "not_connected",
    source,
    review_status: reviewStatus,
  };

  const { data, error } = await supabase
    .from("growth_accounts")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) {
    const repoErr = fromPostgres(error, "Failed to import account.");
    return mcpFail(operationType, repoErr.message, "upstream_failure", {
      durationMs: Date.now() - start,
    });
  }

  const row = data as unknown as GrowthAccountRow;

  await logMcpOperation({
    workspaceId: membership.workspace.id,
    operationType,
    source,
    title: `Account "${row.display_name ?? row.platform}" imported (${reviewStatus})`,
    description: `Platform: ${row.platform}. Connection: not_connected.`,
    entityType: "account",
    entityId: row.id,
    metadata: {
      reviewStatus,
      platform: row.platform,
    },
  });

  return mcpOk(
    operationType,
    {
      accountId: row.id,
      source,
      reviewStatus,
    },
    {
      notes: [
        reviewStatus === "pending_review"
          ? "Account saved as pending_review. Confirm before using it."
          : "Account saved as confirmed.",
        "OAuth is not connected. Signal never asks for passwords, cookies, session tokens, 2FA codes, or recovery codes.",
      ],
      durationMs: Date.now() - start,
    },
  );
}
