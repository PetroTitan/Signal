"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAccount } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { RepositoryError } from "@/repositories/errors";

export interface AccountActionState {
  ok: boolean;
  error: string | null;
}

export async function createAccountAction(
  _prevState: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const platform = String(formData.get("platform") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const handle = String(formData.get("handle") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const productId = String(formData.get("product_id") ?? "").trim();

  if (!platform) return { ok: false, error: "Platform is required." };
  if (!displayName) return { ok: false, error: "Display name is required." };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const account = await createAccount({
      workspaceId: membership.workspace.id,
      platform,
      displayName,
      handle: handle || null,
      role: role || null,
      productId: productId || null,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "account.created",
      entityType: "account",
      entityId: account.id,
      title: `Account "${account.displayName ?? account.platform}" added`,
      description: `Platform: ${account.platform}. Status: not_connected.`,
      metadata: { platform: account.platform, role: account.role },
    });
    revalidatePath("/accounts");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
  } catch (error) {
    const message =
      error instanceof RepositoryError ? error.message : "Failed to create account.";
    return { ok: false, error: message };
  }

  redirect("/accounts");
}
