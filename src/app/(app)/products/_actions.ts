"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createProduct,
  type Product,
} from "@/repositories/product-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { RepositoryError } from "@/repositories/errors";

export interface ProductActionState {
  ok: boolean;
  error: string | null;
  created?: Product;
}

export async function createProductAction(
  _prevState: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();

  if (!name) {
    return { ok: false, error: "Product name is required." };
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return { ok: false, error: "No workspace found." };
    }
    const product = await createProduct({
      workspaceId: membership.workspace.id,
      name,
      domain: domain || null,
      summary: summary || null,
      category: category || null,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "product.created",
      entityType: "product",
      entityId: product.id,
      title: `Product "${product.name}" created`,
      description: product.domain ?? null,
      metadata: { category: product.category },
    });
    revalidatePath("/products");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
  } catch (error) {
    const message =
      error instanceof RepositoryError ? error.message : "Failed to create product.";
    return { ok: false, error: message };
  }

  redirect("/products");
}
