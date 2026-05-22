"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  getCurrentWeeklyPlan,
} from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";

export interface WeeklyPlanActionState {
  ok: boolean;
  error: string | null;
}

function isoMonday(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

export async function createWeeklyPlanAction(
  _prev: WeeklyPlanActionState,
  formData: FormData,
): Promise<WeeklyPlanActionState> {
  const title = String(formData.get("title") ?? "").trim() || "This week";
  const weekStartRaw = String(formData.get("week_start") ?? "").trim();
  const weekStart = weekStartRaw || isoMonday(new Date());

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };
    const plan = await createWeeklyPlan({
      workspaceId: membership.workspace.id,
      title,
      weekStart,
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "weekly_plan.created",
      entityType: "weekly_plan",
      entityId: plan.id,
      title: `Weekly plan "${plan.title}" created`,
      description: `Week of ${plan.weekStart}.`,
    });
    revalidatePath("/weekly-plan");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to create weekly plan.",
    };
  }
  redirect("/weekly-plan");
}

export interface CreateItemActionState {
  ok: boolean;
  error: string | null;
}

export async function createPlanItemAction(
  _prev: CreateItemActionState,
  formData: FormData,
): Promise<CreateItemActionState> {
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim() || null;
  const platform = String(formData.get("platform") ?? "").trim() || null;
  const contentType = String(formData.get("content_type") ?? "").trim() || null;
  const productId = String(formData.get("product_id") ?? "").trim() || null;
  const accountId = String(formData.get("account_id") ?? "").trim() || null;

  if (!title) return { ok: false, error: "Title is required." };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return { ok: false, error: "No workspace found." };

    let plan = await getCurrentWeeklyPlan(membership.workspace.id);
    if (!plan) {
      plan = await createWeeklyPlan({
        workspaceId: membership.workspace.id,
        title: "This week",
        weekStart: isoMonday(new Date()),
      });
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "weekly_plan.created",
        entityType: "weekly_plan",
        entityId: plan.id,
        title: "Weekly plan created",
        description: `Week of ${plan.weekStart}.`,
      });
    }

    const item = await createPlanItem({
      workspaceId: membership.workspace.id,
      weeklyPlanId: plan.id,
      title,
      body,
      platform,
      contentType,
      productId,
      accountId,
      status: "pending_approval",
    });
    await recordActivity({
      workspaceId: membership.workspace.id,
      eventType: "weekly_plan_item.created",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Item "${item.title ?? "Untitled"}" added`,
      description: platform ? `Platform: ${platform}.` : null,
    });
    revalidatePath("/weekly-plan");
    revalidatePath("/approval-queue");
    revalidatePath("/activity");
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RepositoryError
          ? error.message
          : "Failed to add plan item.",
    };
  }
}
