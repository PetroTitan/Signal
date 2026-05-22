"use server";

import { revalidatePath } from "next/cache";
import { createProduct } from "@/repositories/product-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type CreateProductResult = ActionResult<{ productId: string }>;

export async function createProductAction(
  _prevState: CreateProductResult,
  formData: FormData,
): Promise<CreateProductResult> {
  const name = String(formData.get("name") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();

  if (!name) {
    return actionFail("Product name is required.");
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return actionFail("No workspace found. Try refreshing the page.");
    }

    const product = await createProduct({
      workspaceId: membership.workspace.id,
      name,
      domain: domain || null,
      summary: summary || null,
      category: category || null,
    });

    // Activity logging is best-effort. We never undo a successful product
    // creation because the audit row didn't go in.
    try {
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "product.created",
        entityType: "product",
        entityId: product.id,
        title: `Product "${product.name}" created`,
        description: product.domain ?? null,
        metadata: { category: product.category },
      });
    } catch (err) {
      console.error("[createProductAction] activity log failed", err);
    }

    revalidatePath("/products");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
    return actionOk({ productId: product.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not create product.";
    console.error("[createProductAction] failed", error);
    return actionFail(message);
  }
}
