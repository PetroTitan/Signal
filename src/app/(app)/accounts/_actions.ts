"use server";

import { revalidatePath } from "next/cache";
import { createAccount } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type CreateAccountResult = ActionResult<{ accountId: string }>;

export async function createAccountAction(
  _prevState: CreateAccountResult,
  formData: FormData,
): Promise<CreateAccountResult> {
  const platform = String(formData.get("platform") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const handle = String(formData.get("handle") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const productId = String(formData.get("product_id") ?? "").trim();

  if (!platform) return actionFail("Platform is required.");
  if (!displayName) return actionFail("Display name is required.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return actionFail("No workspace found. Try refreshing the page.");
    }

    // Validate the product_id (if provided) belongs to this workspace.
    // Listing is cheap and avoids relying on a constraint violation to
    // surface a clearer message.
    let resolvedProductId: string | null = null;
    if (productId) {
      const products = await listProducts(membership.workspace.id);
      const match = products.find((p) => p.id === productId);
      if (!match) {
        return actionFail("Pick a product that belongs to this workspace.");
      }
      resolvedProductId = match.id;
    }

    const account = await createAccount({
      workspaceId: membership.workspace.id,
      platform,
      displayName,
      handle: handle || null,
      role: role || null,
      productId: resolvedProductId,
    });

    try {
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "account.created",
        entityType: "account",
        entityId: account.id,
        title: `Account "${account.displayName ?? account.platform}" added`,
        description: `Platform: ${account.platform}. Status: not_connected.`,
        metadata: { platform: account.platform, role: account.role },
      });
    } catch (err) {
      console.error("[createAccountAction] activity log failed", err);
    }

    revalidatePath("/accounts");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
    return actionOk({ accountId: account.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not create account.";
    console.error("[createAccountAction] failed", error);
    return actionFail(message);
  }
}
