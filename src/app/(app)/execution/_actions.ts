"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  cancelQueue,
  createExecutionQueue,
  getActiveExecutionQueue,
  getExecutionQueueById,
  markQueueReady,
  pauseQueue,
  resumeQueue,
} from "@/repositories/execution-queue-repository";
import {
  attachAuthorization,
  createExecutionItem,
  getExecutionItemById,
  listItemsForQueue,
  updateItemStatus,
} from "@/repositories/execution-item-repository";
import {
  finishAttempt,
  startAttempt,
} from "@/repositories/execution-attempt-repository";
import { recordLog, recordLogs } from "@/repositories/execution-log-repository";
import {
  listPlanItemsByStatus,
} from "@/repositories/weekly-plan-repository";
import {
  recordExecutionAuthorization,
  loadCadenceSnapshotForContract,
} from "@/repositories/execution-authorization-repository";
import {
  getActiveContract,
  getWeeklyContractById,
} from "@/repositories/weekly-contract-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import {
  assertEngineSafetyEnvelope,
  composeQueueLog,
  planDryRunForItem,
  type ExecutionItem,
} from "@/core/execution-engine";
import {
  toLocalDayKey,
  toLocalMoment,
  type WeeklyContractActionType,
} from "@/core/weekly-contract";

export type CreateQueueResult = ActionResult<{ queueId: string }>;
export type QueueLifecycleResult = ActionResult<{ queueId: string }>;
export type QueueItemsResult = ActionResult<{ queued: number }>;
export type ItemAuthorizeResult = ActionResult<{
  itemId: string;
  authorized: boolean;
  reason: string;
}>;
export type DryRunResult = ActionResult<{
  itemId: string;
  outcome: string;
  message: string;
}>;
export type DryRunQueueResult = ActionResult<{
  queueId: string;
  evaluated: number;
}>;

async function logActivityBestEffort(
  input: Parameters<typeof recordActivity>[0],
) {
  try {
    await recordActivity(input);
  } catch (err) {
    console.error("[execution] activity log failed", err);
  }
}

// =====================================================================
// Queue lifecycle
// =====================================================================

export async function createExecutionQueueAction(
  _prev: CreateQueueResult,
  formData: FormData,
): Promise<CreateQueueResult> {
  const title = String(formData.get("title") ?? "").trim() || "Execution queue";
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const contract = await getActiveContract(membership.workspace.id);
    if (!contract) {
      return actionFail(
        "No active weekly contract. Approve and activate one before creating a queue.",
      );
    }

    const queue = await createExecutionQueue({
      workspaceId: membership.workspace.id,
      contractId: contract.id,
      title,
      weekStart: contract.weekStart,
      weekEnd: contract.weekEnd,
    });

    await recordLog(
      composeQueueLog({
        workspaceId: membership.workspace.id,
        queueId: queue.id,
        eventType: "queue.created",
        message: `Queue "${queue.title}" created for contract ${contract.id}.`,
      }),
    );

    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "execution_queue.created",
      entityType: "execution_queue",
      entityId: queue.id,
      title: `Execution queue "${queue.title}" created`,
      description: `Week of ${queue.weekStart}.`,
    });

    revalidatePath("/execution");
    revalidatePath("/activity");
    return actionOk({ queueId: queue.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Could not create queue.",
    );
  }
}

export async function pauseExecutionQueueAction(
  _prev: QueueLifecycleResult,
  formData: FormData,
): Promise<QueueLifecycleResult> {
  return runQueueLifecycle(formData, async (workspaceId, queueId) => {
    const queue = await pauseQueue(workspaceId, queueId);
    await recordLog(
      composeQueueLog({
        workspaceId,
        queueId,
        eventType: "queue.paused",
        message: "Queue paused by operator.",
        severity: "warning",
      }),
    );
    await logActivityBestEffort({
      workspaceId,
      eventType: "execution_queue.paused",
      entityType: "execution_queue",
      entityId: queueId,
      title: `Execution queue "${queue.title}" paused`,
      description: null,
    });
    return queue;
  });
}

export async function resumeExecutionQueueAction(
  _prev: QueueLifecycleResult,
  formData: FormData,
): Promise<QueueLifecycleResult> {
  return runQueueLifecycle(formData, async (workspaceId, queueId) => {
    const queue = await resumeQueue(workspaceId, queueId);
    await recordLog(
      composeQueueLog({
        workspaceId,
        queueId,
        eventType: "queue.resumed",
        message: "Queue resumed by operator.",
      }),
    );
    await logActivityBestEffort({
      workspaceId,
      eventType: "execution_queue.resumed",
      entityType: "execution_queue",
      entityId: queueId,
      title: `Execution queue "${queue.title}" resumed`,
      description: null,
    });
    return queue;
  });
}

export async function cancelExecutionQueueAction(
  _prev: QueueLifecycleResult,
  formData: FormData,
): Promise<QueueLifecycleResult> {
  return runQueueLifecycle(formData, async (workspaceId, queueId) => {
    const queue = await cancelQueue(workspaceId, queueId);
    await recordLog(
      composeQueueLog({
        workspaceId,
        queueId,
        eventType: "queue.cancelled",
        message: "Queue cancelled by operator.",
        severity: "warning",
      }),
    );
    await logActivityBestEffort({
      workspaceId,
      eventType: "execution_queue.cancelled",
      entityType: "execution_queue",
      entityId: queueId,
      title: `Execution queue "${queue.title}" cancelled`,
      description: null,
    });
    return queue;
  });
}

async function runQueueLifecycle(
  formData: FormData,
  apply: (
    workspaceId: string,
    queueId: string,
  ) => Promise<{ id: string }>,
): Promise<QueueLifecycleResult> {
  const queueId = String(formData.get("queue_id") ?? "").trim();
  if (!queueId) return actionFail("Missing queue id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const result = await apply(membership.workspace.id, queueId);
    revalidatePath("/execution");
    revalidatePath(`/execution/${queueId}`);
    revalidatePath("/activity");
    return actionOk({ queueId: result.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Queue lifecycle failed.",
    );
  }
}

// =====================================================================
// Queue plan items
// =====================================================================

export async function queueWeeklyPlanItemsAction(
  _prev: QueueItemsResult,
  formData: FormData,
): Promise<QueueItemsResult> {
  const queueId = String(formData.get("queue_id") ?? "").trim();
  if (!queueId) return actionFail("Missing queue id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const queue = await getExecutionQueueById(membership.workspace.id, queueId);
    if (queue.status !== "draft" && queue.status !== "ready") {
      return actionFail(
        `Queue must be in 'draft' or 'ready' to add items (current: ${queue.status}).`,
      );
    }

    // Contract-free queues (per-post path) skip the contract scope
    // check. Contract-attached queues still enforce active status
    // and scope at queue time as defense-in-depth.
    const contract = queue.contractId
      ? await getWeeklyContractById(membership.workspace.id, queue.contractId)
      : null;
    if (contract && contract.status !== "active") {
      return actionFail(
        `Queue's contract is "${contract.status}". Activate it before queuing items.`,
      );
    }

    // Only confirmed/approved plan items become execution items.
    const planItems = await listPlanItemsByStatus(membership.workspace.id, [
      "approved",
      "scheduled",
    ]);

    const eligible = planItems.filter((p) => {
      if (!contract) return true; // contract-free queue: no scope filter
      if (p.accountId && !contract.scope.accountIds.includes(p.accountId)) {
        return false;
      }
      if (p.productId && !contract.scope.productIds.includes(p.productId)) {
        return false;
      }
      if (p.platform && !contract.scope.platforms.includes(p.platform)) {
        return false;
      }
      return true;
    });

    let queuedCount = 0;
    for (const plan of eligible) {
      const item = await createExecutionItem({
        workspaceId: membership.workspace.id,
        queueId: queue.id,
        // Inherit contract from the queue (null on contract-free queues).
        contractId: contract ? contract.id : null,
        actionType: pickActionTypeForPlanItem(plan.platform, plan.contentType),
        sourceEntityType: "weekly_plan_item",
        sourceEntityId: plan.id,
        productId: plan.productId,
        accountId: plan.accountId,
        platform: plan.platform,
        title: plan.title,
        body: plan.body,
        linkUrl: plan.linkUrl,
        scheduledAt: plan.scheduledAt,
        riskScore: plan.riskScore,
        riskLevel: plan.riskLevel,
      });
      await recordLog(
        composeQueueLog({
          workspaceId: membership.workspace.id,
          queueId: queue.id,
          eventType: "item.queued",
          message: `Plan item ${plan.id} queued as execution_item ${item.id}.`,
          metadata: { itemId: item.id, planItemId: plan.id },
        }),
      );
      await logActivityBestEffort({
        workspaceId: membership.workspace.id,
        eventType: "execution_item.queued",
        entityType: "execution_item",
        entityId: item.id,
        title: `Item queued: ${plan.title ?? "(untitled)"}`,
        description: plan.platform ? `Platform: ${plan.platform}.` : null,
      });
      queuedCount += 1;
    }

    if (queuedCount > 0 && queue.status === "draft") {
      await markQueueReady(membership.workspace.id, queue.id);
      await recordLog(
        composeQueueLog({
          workspaceId: membership.workspace.id,
          queueId: queue.id,
          eventType: "queue.ready",
          message: `Queue marked ready with ${queuedCount} item(s).`,
        }),
      );
    }

    revalidatePath("/execution");
    revalidatePath(`/execution/${queueId}`);
    revalidatePath("/activity");
    return actionOk({ queued: queuedCount });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Could not queue items.",
    );
  }
}

function pickActionTypeForPlanItem(
  platform: string | null,
  contentType: string | null,
): WeeklyContractActionType {
  if (contentType === "comment") return "publish_scheduled_comment";
  if (platform) return "publish_scheduled_post";
  return "publish_scheduled_post";
}

// =====================================================================
// Authorize + dry-run
// =====================================================================

async function evaluateAndAuthorize(input: {
  workspaceId: string;
  item: ExecutionItem;
}): Promise<{
  item: ExecutionItem;
  outcome: "executed" | "backlogged" | "skipped" | "blocked";
  message: string;
}> {
  const { workspaceId, item } = input;

  const contract = await getActiveContract(workspaceId);
  const safety = assertEngineSafetyEnvelope({
    contract,
    isDemoWorkspace: false,
    invocation: "operator_dry_run",
  });
  if (!safety.allowed) {
    throw new RepositoryError(safety.reason, "constraint");
  }
  if (!contract) {
    throw new RepositoryError("No active contract.", "constraint");
  }

  const cadenceSnapshot = await loadCadenceSnapshotForContract({
    workspaceId,
    contractId: contract.id,
    weekStartIso: `${contract.weekStart}T00:00:00Z`,
    weekEndIso: `${contract.weekEnd}T23:59:59Z`,
    timezone: null,
  });

  const nowIso = new Date().toISOString();
  const plan = planDryRunForItem({
    item,
    contract,
    cadenceSnapshot,
    localMoment: toLocalMoment(nowIso, null),
    localDayKey: toLocalDayKey(nowIso, null),
    isDemoWorkspace: false,
  });

  const attempt = await startAttempt({
    workspaceId,
    itemId: item.id,
    attemptNumber: item.attemptCount + 1,
    metadata: { dry_run: true, action_type: item.actionType },
  });

  const auth = await recordExecutionAuthorization({
    context: {
      workspaceId,
      contractId: contract.id,
      actionType: item.actionType as WeeklyContractActionType,
      accountId: item.accountId,
      productId: item.productId,
      platform: item.platform,
      scheduledItemId: null,
      weeklyPlanItemId: item.sourceEntityId,
      extraMetadata: { execution_item_id: item.id, dry_run: true },
    },
    result: plan.authorization,
  });

  await attachAuthorization({
    workspaceId,
    itemId: item.id,
    authorizationId: auth.id,
  });

  await recordLogs(plan.logs);

  const nextStatus =
    plan.dryRun.kind === "executed"
      ? "completed"
      : plan.dryRun.kind === "backlogged"
      ? "backlogged"
      : plan.dryRun.kind === "skipped"
      ? "skipped"
      : "blocked";

  // Walk the state machine: pending_authorization → authorized → completed
  // (or whichever terminal state). We do it in two steps so logs reflect
  // the authorization gate as its own event.
  if (item.status === "pending_authorization" && plan.authorization.severity === "allow") {
    await updateItemStatus({
      workspaceId,
      itemId: item.id,
      to: "authorized",
    });
  }
  const updated = await updateItemStatus({
    workspaceId,
    itemId: item.id,
    to: nextStatus,
    patch: { attempt_count: item.attemptCount + 1 },
  });

  await finishAttempt({
    workspaceId,
    attemptId: attempt.id,
    status:
      plan.dryRun.kind === "executed"
        ? "succeeded"
        : plan.dryRun.kind === "blocked"
        ? "blocked"
        : "skipped",
    metadata: { dryRunKind: plan.dryRun.kind },
  });

  return {
    item: updated,
    outcome: plan.dryRun.kind,
    message: plan.dryRun.message,
  };
}

export async function authorizeExecutionItemAction(
  _prev: ItemAuthorizeResult,
  formData: FormData,
): Promise<ItemAuthorizeResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const item = await getExecutionItemById(membership.workspace.id, itemId);
    const result = await evaluateAndAuthorize({
      workspaceId: membership.workspace.id,
      item,
    });

    if (result.outcome !== "blocked") {
      await logActivityBestEffort({
        workspaceId: membership.workspace.id,
        eventType:
          result.outcome === "executed"
            ? "execution_item.authorized"
            : result.outcome === "backlogged"
            ? "execution_item.backlogged"
            : "execution_item.blocked",
        entityType: "execution_item",
        entityId: itemId,
        title: `Execution item ${result.outcome}`,
        description: result.message,
      });
    } else {
      await logActivityBestEffort({
        workspaceId: membership.workspace.id,
        eventType: "execution_item.blocked",
        entityType: "execution_item",
        entityId: itemId,
        title: `Execution item blocked`,
        description: result.message,
      });
    }

    revalidatePath("/execution");
    revalidatePath(`/execution/${result.item.queueId}`);
    revalidatePath("/activity");
    return actionOk({
      itemId,
      authorized: result.outcome === "executed",
      reason: result.message,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Authorize failed.",
    );
  }
}

export async function dryRunExecutionItemAction(
  _prev: DryRunResult,
  formData: FormData,
): Promise<DryRunResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const item = await getExecutionItemById(membership.workspace.id, itemId);

    if (
      item.status !== "pending_authorization" &&
      item.status !== "authorized" &&
      item.status !== "ready" &&
      item.status !== "scheduled" &&
      item.status !== "paused" &&
      item.status !== "failed"
    ) {
      return actionFail(
        `Item is in terminal state "${item.status}" and cannot be dry-run again.`,
      );
    }

    const result = await evaluateAndAuthorize({
      workspaceId: membership.workspace.id,
      item,
    });

    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "execution_item.dry_run_completed",
      entityType: "execution_item",
      entityId: itemId,
      title: `Dry-run ${result.outcome} for execution item`,
      description: result.message,
    });

    revalidatePath("/execution");
    revalidatePath(`/execution/${result.item.queueId}`);
    revalidatePath("/activity");
    return actionOk({
      itemId,
      outcome: result.outcome,
      message: result.message,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Dry-run failed.",
    );
  }
}

export async function dryRunQueueAction(
  _prev: DryRunQueueResult,
  formData: FormData,
): Promise<DryRunQueueResult> {
  const queueId = String(formData.get("queue_id") ?? "").trim();
  if (!queueId) return actionFail("Missing queue id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const items = await listItemsForQueue(membership.workspace.id, queueId);
    let evaluated = 0;
    for (const item of items) {
      if (
        item.status !== "pending_authorization" &&
        item.status !== "authorized" &&
        item.status !== "ready" &&
        item.status !== "scheduled" &&
        item.status !== "paused"
      ) {
        continue;
      }
      await evaluateAndAuthorize({
        workspaceId: membership.workspace.id,
        item,
      });
      evaluated += 1;
    }

    revalidatePath("/execution");
    revalidatePath(`/execution/${queueId}`);
    revalidatePath("/activity");
    return actionOk({ queueId, evaluated });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Queue dry-run failed.",
    );
  }
}

export async function authorizeQueueAction(
  _prev: DryRunQueueResult,
  formData: FormData,
): Promise<DryRunQueueResult> {
  // Same effect as dryRunQueueAction in Phase E2 — authorization and
  // execution are the same in dry-run mode. Kept as a separate action
  // so the UI can label it clearly and so a future phase can split the
  // two when external publishing arrives.
  return dryRunQueueAction(_prev, formData);
}
