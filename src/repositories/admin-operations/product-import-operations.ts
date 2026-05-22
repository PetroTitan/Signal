import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ProductInsert,
  ProductRow,
} from "@/lib/supabase/types";
import {
  assertConfirmationOrPending,
  mcpFail,
  mcpOk,
  operationDefaultSource,
  type McpOperationResult,
  type OperationContext,
} from "@/core/mcp-operations";
import { fromPostgres, notAuthenticated } from "@/repositories/errors";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getProductById } from "@/repositories/product-repository";
import { logMcpOperation } from "./operation-audit";

export interface ProductImportInput {
  name: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
}

export interface ProductImportPayload {
  productId: string;
  source: string;
  reviewStatus: "pending_review" | "confirmed";
}

/**
 * Create a product from an MCP-driven import. Defaults to
 * `review_status = pending_review` unless the user already confirmed
 * the extracted fields in the import UI. Always writes the
 * `screenshot_import` source.
 */
export async function importProductFromScreenshot(
  input: ProductImportInput,
  ctx: OperationContext,
): Promise<McpOperationResult<ProductImportPayload>> {
  const operationType = "screenshot_product_import" as const;
  const start = Date.now();

  if (!input.name || input.name.trim().length === 0) {
    return mcpFail(
      operationType,
      "Product name is required.",
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

  const insert: ProductInsert = {
    workspace_id: membership.workspace.id,
    name: input.name.trim(),
    domain: input.domain ?? null,
    summary: input.summary ?? null,
    category: input.category ?? null,
    source,
    review_status: reviewStatus,
  };

  const { data, error } = await supabase
    .from("products")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) {
    const repoErr = fromPostgres(error, "Failed to import product.");
    return mcpFail(operationType, repoErr.message, "upstream_failure", {
      durationMs: Date.now() - start,
    });
  }

  const row = data as unknown as ProductRow;

  await logMcpOperation({
    workspaceId: membership.workspace.id,
    operationType,
    source,
    title: `Product "${row.name}" imported (${reviewStatus})`,
    description: row.domain ?? null,
    entityType: "product",
    entityId: row.id,
    metadata: {
      category: row.category,
      reviewStatus,
    },
  });

  return mcpOk(
    operationType,
    {
      productId: row.id,
      source,
      reviewStatus,
    },
    {
      notes: [
        reviewStatus === "pending_review"
          ? "Product saved as pending_review. Confirm before using it in plans."
          : "Product saved as confirmed. Visible to all members.",
      ],
      durationMs: Date.now() - start,
    },
  );
}

/**
 * Marks an imported product as confirmed. Throws via the repository
 * layer's RepositoryError if the user is not a workspace member.
 */
export async function confirmImportedProduct(
  productId: string,
): Promise<McpOperationResult<ProductImportPayload>> {
  const operationType = "product_profile_confirm" as const;
  const start = Date.now();

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return mcpFail(operationType, "No workspace found.", "not_authorized", {
      durationMs: Date.now() - start,
    });
  }

  const existing = await getProductById(membership.workspace.id, productId);

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({ review_status: "confirmed" } as never)
    .eq("workspace_id", membership.workspace.id)
    .eq("id", productId);
  if (error) {
    const repoErr = fromPostgres(error, "Failed to confirm product.");
    return mcpFail(operationType, repoErr.message, "upstream_failure", {
      durationMs: Date.now() - start,
    });
  }

  await logMcpOperation({
    workspaceId: membership.workspace.id,
    operationType,
    source: existing.source === "manual" ? "manual" : "ai_assisted",
    title: `Product "${existing.name}" confirmed`,
    entityType: "product",
    entityId: productId,
  });

  return mcpOk(
    operationType,
    {
      productId,
      source: existing.source,
      reviewStatus: "confirmed",
    },
    { durationMs: Date.now() - start },
  );
}
