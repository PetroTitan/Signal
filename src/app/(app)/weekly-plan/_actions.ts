"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  getCurrentWeeklyPlan,
} from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type CreateWeeklyPlanResult = ActionResult<{ planId: string }>;
export type CreatePlanItemResult = ActionResult<{ itemId: string }>;

function isoMonday(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

async function logActivityBestEffort(input: Parameters<typeof recordActivity>[0]) {
  try {
    await recordActivity(input);
  } catch (err) {
    console.error("[weekly-plan] activity log failed", err);
  }
}

export async function createWeeklyPlanAction(
  _prev: CreateWeeklyPlanResult,
  formData: FormData,
): Promise<CreateWeeklyPlanResult> {
  const title = String(formData.get("title") ?? "").trim() || "This week";
  const weekStartRaw = String(formData.get("week_start") ?? "").trim();
  const weekStart = weekStartRaw || isoMonday(new Date());

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const plan = await createWeeklyPlan({
      workspaceId: membership.workspace.id,
      title,
      weekStart,
    });
    await logActivityBestEffort({
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
    return actionOk({ planId: plan.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not create weekly plan.";
    console.error("[createWeeklyPlanAction] failed", error);
    return actionFail(message);
  }
}

export async function createPlanItemAction(
  _prev: CreatePlanItemResult,
  formData: FormData,
): Promise<CreatePlanItemResult> {
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim() || null;
  const platform = String(formData.get("platform") ?? "").trim() || null;
  const contentType = String(formData.get("content_type") ?? "").trim() || null;
  const productId = String(formData.get("product_id") ?? "").trim() || null;
  const accountId = String(formData.get("account_id") ?? "").trim() || null;

  if (!title) return actionFail("Title is required.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    let plan = await getCurrentWeeklyPlan(membership.workspace.id);
    if (!plan) {
      plan = await createWeeklyPlan({
        workspaceId: membership.workspace.id,
        title: "This week",
        weekStart: isoMonday(new Date()),
      });
      await logActivityBestEffort({
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
    await logActivityBestEffort({
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
    return actionOk({ itemId: item.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError ? error.message : "Could not add plan item.";
    console.error("[createPlanItemAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F1 — approveWeeklyPlanAction
// =====================================================================
//
// One-click approval for the whole plan: bumps every pending_approval
// item to approved, creates/reuses the contract's execution_queue,
// and lays down execution_items in 'scheduled' state with the
// plan item's scheduled_at timestamp. The /api/scheduler/tick loop
// then picks them up.

export type ApproveWeeklyPlanResult = ActionResult<{
  planId: string;
  itemsApproved: number;
  executionItemsCreated: number;
  warnings: string[];
}>;

export async function approveWeeklyPlanAction(
  _prev: ApproveWeeklyPlanResult,
  formData: FormData,
): Promise<ApproveWeeklyPlanResult> {
  const planId = String(formData.get("plan_id") ?? "").trim();
  if (!planId) return actionFail("Missing plan id.");

  const { getActiveContract } = await import(
    "@/repositories/weekly-contract-repository"
  );
  const {
    getActiveExecutionQueue,
    createExecutionQueue,
  } = await import("@/repositories/execution-queue-repository");
  const { createExecutionItem, updateItemStatus } = await import(
    "@/repositories/execution-item-repository"
  );
  const { recordLog } = await import(
    "@/repositories/execution-log-repository"
  );
  const { listPlanItems, updatePlanItemStatus } = await import(
    "@/repositories/weekly-plan-repository"
  );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const contract = await getActiveContract(workspaceId);
    if (!contract) {
      return actionFail(
        "No active weekly contract. Activate a contract at /weekly-contracts before approving the plan.",
      );
    }

    const allItems = await listPlanItems(workspaceId, planId);
    const pendingItems = allItems.filter(
      (i) => i.status === "pending_approval",
    );
    if (pendingItems.length === 0) {
      return actionFail(
        "No items in pending_approval. Nothing to approve.",
      );
    }

    const warnings: string[] = [];
    const validItems = pendingItems.filter((it) => {
      if (it.riskLevel === "blocked") {
        warnings.push(
          `Skipped "${it.title ?? "Untitled"}" — risk level blocked.`,
        );
        return false;
      }
      if (it.accountId && !contract.scope.accountIds.includes(it.accountId)) {
        warnings.push(
          `Skipped "${it.title ?? "Untitled"}" — account out of contract scope.`,
        );
        return false;
      }
      if (it.productId && !contract.scope.productIds.includes(it.productId)) {
        warnings.push(
          `Skipped "${it.title ?? "Untitled"}" — product out of contract scope.`,
        );
        return false;
      }
      if (it.platform && !contract.scope.platforms.includes(it.platform)) {
        warnings.push(
          `Skipped "${it.title ?? "Untitled"}" — platform out of contract scope.`,
        );
        return false;
      }
      return true;
    });

    if (validItems.length === 0) {
      return actionFail(
        `All ${pendingItems.length} pending item(s) failed contract-scope checks. ` +
          warnings.slice(0, 3).join(" "),
      );
    }

    // Get or create the execution queue for this contract.
    let queue = await getActiveExecutionQueue(workspaceId, contract.id);
    if (!queue) {
      queue = await createExecutionQueue({
        workspaceId,
        contractId: contract.id,
        title: `Auto-created queue for ${contract.title}`,
        weekStart: contract.weekStart,
        weekEnd: contract.weekEnd,
      });
    }

    let itemsApproved = 0;
    let executionItemsCreated = 0;
    for (const it of validItems) {
      const execItem = await createExecutionItem({
        workspaceId,
        queueId: queue.id,
        contractId: contract.id,
        actionType:
          it.contentType === "comment"
            ? "publish_scheduled_comment"
            : "publish_scheduled_post",
        sourceEntityType: "weekly_plan_item",
        sourceEntityId: it.id,
        productId: it.productId,
        accountId: it.accountId,
        platform: it.platform,
        title: it.title,
        body: it.body,
        linkUrl: it.linkUrl,
        scheduledAt: it.scheduledAt,
        riskScore: it.riskScore,
        riskLevel: it.riskLevel,
        metadata: {
          plan_item_id: it.id,
          plan_id: planId,
          source: "approve_weekly_plan",
        },
      });
      executionItemsCreated += 1;
      // Walk execution_item to 'scheduled' so the scheduler picks it up.
      // Transition path: pending_authorization → authorized → scheduled.
      await updateItemStatus({
        workspaceId,
        itemId: execItem.id,
        to: "authorized",
      });
      await updateItemStatus({
        workspaceId,
        itemId: execItem.id,
        to: "scheduled",
      });

      // Bump the plan_item to 'scheduled' so the operator sees it move
      // out of the approval queue.
      await updatePlanItemStatus({
        workspaceId,
        itemId: it.id,
        status: "scheduled",
      });
      itemsApproved += 1;
      await recordLog({
        workspaceId,
        queueId: queue.id,
        executionItemId: execItem.id,
        eventType: "item.scheduled",
        severity: "info",
        message: `Weekly plan approval scheduled "${it.title ?? "Untitled"}" for ${it.scheduledAt ?? "(immediate)"}`,
        metadata: { plan_item_id: it.id, plan_id: planId },
      });
    }

    try {
      await recordActivity({
        workspaceId,
        eventType: "weekly_plan.approved",
        entityType: "weekly_plan",
        entityId: planId,
        title: `Weekly plan approved (${itemsApproved} item${
          itemsApproved === 1 ? "" : "s"
        })`,
        description:
          warnings.length > 0
            ? `${warnings.length} item(s) skipped — see warnings.`
            : null,
        metadata: {
          queue_id: queue.id,
          execution_items_created: executionItemsCreated,
        },
      });
    } catch (err) {
      console.error("[approveWeeklyPlanAction] activity log failed", err);
    }

    revalidatePath("/weekly-plan");
    revalidatePath("/approval-queue");
    revalidatePath("/execution");
    revalidatePath(`/execution/${queue.id}`);
    revalidatePath("/activity");
    return actionOk({
      planId,
      itemsApproved,
      executionItemsCreated,
      warnings,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
        ? error.message
        : "Could not approve weekly plan.";
    console.error("[approveWeeklyPlanAction] failed", error);
    return actionFail(message);
  }
}
