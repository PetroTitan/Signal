"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getPlanItemById,
  updatePlanItemStatus,
} from "@/repositories/weekly-plan-repository";
import { recordApprovalEvent } from "@/repositories/approval-repository";
import { createBacklogItem } from "@/repositories/backlog-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  approveProductReview,
  archiveProduct,
  rejectProductReview,
} from "@/repositories/product-repository";
import {
  approveAccountReview,
  archiveAccount,
  rejectAccountReview,
} from "@/repositories/account-repository";
import { RepositoryError } from "@/repositories/errors";

export interface ApprovalActionState {
  ok: boolean;
  error: string | null;
}

async function withWorkspace<T>(
  itemId: string,
  fn: (membership: NonNullable<Awaited<ReturnType<typeof getPrimaryWorkspace>>>, _: { itemId: string }) => Promise<T>,
): Promise<T> {
  const membership = await getPrimaryWorkspace();
  if (!membership) throw new Error("No workspace found.");
  return fn(membership, { itemId });
}

export async function approveItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const itemId = String(formData.get("item_id") ?? "");
  if (!itemId) return { ok: false, error: "Item id is required." };

  try {
    await withWorkspace(itemId, async (membership) => {
      const item = await updatePlanItemStatus({
        workspaceId: membership.workspace.id,
        itemId,
        status: "approved",
      });
      await recordApprovalEvent({
        workspaceId: membership.workspace.id,
        weeklyPlanItemId: item.id,
        action: "approve",
      });
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "weekly_plan_item.approved",
        entityType: "weekly_plan_item",
        entityId: item.id,
        title: `Item "${item.title ?? "Untitled"}" approved`,
      });
    });
    revalidatePath("/approval-queue");
    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to approve item.",
    };
  }
}

export async function rejectItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const itemId = String(formData.get("item_id") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!itemId) return { ok: false, error: "Item id is required." };

  try {
    await withWorkspace(itemId, async (membership) => {
      const item = await updatePlanItemStatus({
        workspaceId: membership.workspace.id,
        itemId,
        status: "rejected",
      });
      await recordApprovalEvent({
        workspaceId: membership.workspace.id,
        weeklyPlanItemId: item.id,
        action: "reject",
        note,
      });
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "weekly_plan_item.rejected",
        entityType: "weekly_plan_item",
        entityId: item.id,
        title: `Item "${item.title ?? "Untitled"}" rejected`,
        description: note,
      });
    });
    revalidatePath("/approval-queue");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to reject item.",
    };
  }
}

export async function moveToBacklogAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const itemId = String(formData.get("item_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  if (!itemId) return { ok: false, error: "Item id is required." };

  try {
    await withWorkspace(itemId, async (membership) => {
      const item = await getPlanItemById(membership.workspace.id, itemId);
      await updatePlanItemStatus({
        workspaceId: membership.workspace.id,
        itemId,
        status: "backlog",
      });
      const backlog = await createBacklogItem({
        workspaceId: membership.workspace.id,
        sourceItemId: item.id,
        productId: item.productId,
        accountId: item.accountId,
        platform: item.platform,
        title: item.title,
        body: item.body,
        reason,
      });
      await recordApprovalEvent({
        workspaceId: membership.workspace.id,
        weeklyPlanItemId: item.id,
        action: "send_to_backlog",
        note: reason,
      });
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "backlog_item.created",
        entityType: "backlog_item",
        entityId: backlog.id,
        title: `Item "${item.title ?? "Untitled"}" moved to backlog`,
        description: reason,
      });
    });
    revalidatePath("/approval-queue");
    revalidatePath("/backlog");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to move item to backlog.",
    };
  }
}

// =====================================================================
// Product review actions
// =====================================================================

function revalidateProductPaths() {
  revalidatePath("/approval-queue");
  revalidatePath("/products");
  revalidatePath("/activity");
}

export async function approveProductReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const productId = String(formData.get("product_id") ?? "");
  if (!productId) return { ok: false, error: "Product id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const product = await approveProductReview({
      workspaceId: membership.workspace.id,
      productId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "product.review_confirmed",
      entityType: "product",
      entityId: product.id,
      title: `Product "${product.name}" confirmed`,
      description:
        "Approving a product profile only confirms it inside Signal. No OAuth, publishing, scheduling, or execution.",
    });
    revalidateProductPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to approve product.",
    };
  }
}

export async function rejectProductReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const productId = String(formData.get("product_id") ?? "");
  if (!productId) return { ok: false, error: "Product id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const product = await rejectProductReview({
      workspaceId: membership.workspace.id,
      productId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "product.review_rejected",
      entityType: "product",
      entityId: product.id,
      title: `Product "${product.name}" rejected`,
    });
    revalidateProductPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to reject product.",
    };
  }
}

export async function archiveProductReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const productId = String(formData.get("product_id") ?? "");
  if (!productId) return { ok: false, error: "Product id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const product = await archiveProduct({
      workspaceId: membership.workspace.id,
      productId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "product.review_archived",
      entityType: "product",
      entityId: product.id,
      title: `Product "${product.name}" archived`,
    });
    revalidateProductPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to archive product.",
    };
  }
}

// =====================================================================
// Account review actions
// =====================================================================

function revalidateAccountPaths() {
  revalidatePath("/approval-queue");
  revalidatePath("/accounts");
  revalidatePath("/platforms");
  revalidatePath("/platforms/reddit");
  revalidatePath("/platforms/x");
  revalidatePath("/platforms/linkedin");
  revalidatePath("/activity");
}

export async function approveAccountReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const accountId = String(formData.get("account_id") ?? "");
  if (!accountId) return { ok: false, error: "Account id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const account = await approveAccountReview({
      workspaceId: membership.workspace.id,
      accountId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "account.review_confirmed",
      entityType: "growth_account",
      entityId: account.id,
      title: `Account "${
        account.displayName ?? account.handle ?? account.id
      }" confirmed`,
      description:
        "Approving an account only confirms the profile inside Signal. It does not connect OAuth, publish, comment, or execute.",
    });
    revalidateAccountPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to approve account.",
    };
  }
}

export async function rejectAccountReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const accountId = String(formData.get("account_id") ?? "");
  if (!accountId) return { ok: false, error: "Account id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const account = await rejectAccountReview({
      workspaceId: membership.workspace.id,
      accountId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "account.review_rejected",
      entityType: "growth_account",
      entityId: account.id,
      title: `Account "${
        account.displayName ?? account.handle ?? account.id
      }" rejected`,
    });
    revalidateAccountPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to reject account.",
    };
  }
}

export async function archiveAccountReviewAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const accountId = String(formData.get("account_id") ?? "");
  if (!accountId) return { ok: false, error: "Account id is required." };
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const account = await archiveAccount({
      workspaceId: membership.workspace.id,
      accountId,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "account.review_archived",
      entityType: "growth_account",
      entityId: account.id,
      title: `Account "${
        account.displayName ?? account.handle ?? account.id
      }" archived`,
    });
    revalidateAccountPaths();
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to archive account.",
    };
  }
}
