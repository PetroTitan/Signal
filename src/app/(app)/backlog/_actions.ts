"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getBacklogItemById,
  updateBacklogStatus,
} from "@/repositories/backlog-repository";
import {
  createPlanItem,
  getCurrentWeeklyPlan,
  createWeeklyPlan,
} from "@/repositories/weekly-plan-repository";
import { recordApprovalEvent } from "@/repositories/approval-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";

export interface BacklogActionState {
  ok: boolean;
  error: string | null;
}

function isoMonday(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

export async function restoreBacklogItemAction(
  _prev: BacklogActionState,
  formData: FormData,
): Promise<BacklogActionState> {
  const backlogId = String(formData.get("backlog_id") ?? "");
  if (!backlogId) return { ok: false, error: "Backlog id required." };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const workspaceId = membership.workspace.id;

    const backlog = await getBacklogItemById(workspaceId, backlogId);
    let plan = await getCurrentWeeklyPlan(workspaceId);
    if (!plan) {
      plan = await createWeeklyPlan({
        workspaceId,
        title: "This week",
        weekStart: isoMonday(new Date()),
      });
    }

    const item = await createPlanItem({
      workspaceId,
      weeklyPlanId: plan.id,
      title: backlog.title,
      body: backlog.body,
      platform: backlog.platform,
      productId: backlog.productId,
      accountId: backlog.accountId,
      status: "pending_approval",
      metadata: { restoredFrom: backlog.id },
    });
    await updateBacklogStatus({
      workspaceId,
      backlogId: backlog.id,
      status: "restored",
    });
    await recordApprovalEvent({
      workspaceId,
      weeklyPlanItemId: item.id,
      action: "restore_from_backlog",
    });
    await recordActivity({
      workspaceId,
      eventType: "backlog_item.restored",
      entityType: "backlog_item",
      entityId: backlog.id,
      title: `"${backlog.title ?? "Item"}" restored to this week`,
    });

    revalidatePath("/backlog");
    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to restore item.",
    };
  }
}

export async function archiveBacklogItemAction(
  _prev: BacklogActionState,
  formData: FormData,
): Promise<BacklogActionState> {
  const backlogId = String(formData.get("backlog_id") ?? "");
  if (!backlogId) return { ok: false, error: "Backlog id required." };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const backlog = await updateBacklogStatus({
      workspaceId: membership.workspace.id,
      backlogId,
      status: "archived",
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "backlog_item.archived",
      entityType: "backlog_item",
      entityId: backlog.id,
      title: `"${backlog.title ?? "Item"}" archived from backlog`,
    });
    revalidatePath("/backlog");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to archive item.",
    };
  }
}
