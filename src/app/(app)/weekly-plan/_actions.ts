"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  deletePlanItem,
  getCurrentWeeklyPlan,
  getPlanItemById,
  movePlanItemToPlan,
  updatePlanItem,
} from "@/repositories/weekly-plan-repository";
import { decideBlueskyApprovalShape } from "@/core/platform-native/adapters/bluesky/shape-binding";
import {
  listExecutionItemsByPlanItemIds,
  updateItemStatus as updateExecutionItemStatus,
} from "@/repositories/execution-item-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import type {
  CreativeSourceType,
  CreativeType,
  WeeklyPlanItemUpdate,
} from "@/lib/supabase/types";
import type { AllowedMime } from "@/core/publishing/creative-upload-policy";
import {
  createCreative,
  getCreativeById,
  updateCreative,
} from "@/repositories/weekly-plan-creative-repository";
import { parseScheduledAtField } from "./parse-scheduled-at-field";
import { assessItemApprovalReadiness } from "./approval-readiness.server";
import { selectPrimaryCreativeFromList } from "./_primary-creative-selector";
import {
  emitScheduleParseInvalid,
  emitScheduleSaveRejected,
  emitScheduleSaveSuccess,
  emitScheduleSourceChange,
  type ScheduleSource,
} from "@/core/observability/schedule-events";
import {
  emitApprovalSchedulePreserved,
  emitApprovalStateAssertionFailed,
  emitApprovalTransitionCommitted,
  emitApprovalTransitionFailed,
  emitApprovalTransitionStarted,
} from "@/core/observability/approval-events";
import { scheduleChecksum } from "@/core/scheduling/schedule-checksum";

export type CreateWeeklyPlanResult = ActionResult<{ planId: string }>;
export type CreatePlanItemResult = ActionResult<{ itemId: string }>;
export type UpdatePlanItemResult = ActionResult<{ itemId: string }>;
export type AttachCreativeResult = ActionResult<{ creativeId: string }>;
export type UploadCreativeAssetResult = ActionResult<{
  creativeId: string;
  assetUrl: string;
}>;
export type DuplicatePlanItemResult = ActionResult<{ itemId: string }>;
export type ComposeUpsertDraftResult = ActionResult<{ itemId: string }>;
export type SendForApprovalResult = ActionResult<{ itemId: string }>;
export type ApproveCreativeResult = ActionResult<{
  creativeId: string;
  status: "approved";
}>;
export type RejectCreativeResult = ActionResult<{
  creativeId: string;
  status: "rejected";
}>;
export type SaveScheduleResult = ActionResult<{
  itemId: string;
  scheduledAtIso: string | null;
  /** Server-side checksum of the persisted tuple. Caller can
   *  compare to its own client-side checksum to detect drift. */
  serverChecksum?: string;
  /** The schedule source the server attributed to this write
   *  (manual / preset / mcp / api / migration / recovery). */
  source?: string;
  /** Operator-facing display fields populated when the workspace
   *  timezone is set and the schedule is non-null. Allows the UI to
   *  echo the canonical time without re-deriving from the ISO. */
  scheduledAtLocal?: string | null;
  scheduledAtUtcDebug?: string | null;
  timezone?: string | null;
  dueInSeconds?: number | null;
  dueLabel?: string | null;
  /** "execution_item" | "weekly_plan_item" | "none" — see
   *  src/core/scheduling/effective-publish-schedule.ts. */
  effectiveSource?: "execution_item" | "weekly_plan_item" | "none";
  /** Active execution_item id whose scheduled_at is the publish
   *  trigger. Null when no active execution_item exists. */
  executionItemId?: string | null;
}>;
export type ApprovePlanItemResult = ActionResult<{
  itemId: string;
  /** Verified status after re-read. "approved" for hold path,
   *  "scheduled" for immediate-schedule path. */
  status: "approved" | "scheduled";
  /** Schedule timestamp after the transaction. Must equal the
   *  pre-mutation value (asserted on the server). */
  scheduledAtIso: string | null;
  /** Execution item id when the immediate-schedule path created one;
   *  null for the hold path. */
  executionItemId: string | null;
}>;

export type CancelApprovalResult = ActionResult<{
  itemId: string;
  /** Status the item lands in after cancellation. Always
   *  "pending_approval" today — the operator already reviewed once,
   *  so we keep the readiness signal rather than reverting all the
   *  way to "draft". */
  status: "pending_approval";
  /** Number of execution_items the action cancelled (0 for the
   *  approved-and-held path; ≥1 for the scheduled path). */
  cancelledExecutionItemCount: number;
}>;

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

/**
 * A6 — carry an unfinished item from a previous week's plan into the
 * current plan so it re-enters the main workflow.
 *
 * Safety contract (audited):
 *   - Only unfinished items (draft / pending_approval / approved /
 *     scheduled / paused) can be carried over; terminal items are
 *     refused. Status is PRESERVED — approval is never bypassed.
 *   - Relocates ONLY `weekly_plan_id` (movePlanItemToPlan). The linked
 *     execution_item references the plan_item id (not the plan), so no
 *     execution item is created or duplicated and any existing schedule
 *     keeps firing exactly as before.
 *   - Records an activity event for the audit trail.
 */
const CARRYABLE_STATUSES = new Set([
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "paused",
]);

export async function carryOverPlanItemAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Item id is required.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getPlanItemById(workspaceId, itemId);
    if (!CARRYABLE_STATUSES.has(item.status)) {
      return actionFail(
        "Only unfinished items can be carried over; this one is already finished.",
      );
    }

    let plan = await getCurrentWeeklyPlan(workspaceId);
    if (!plan) {
      plan = await createWeeklyPlan({
        workspaceId,
        title: "This week",
        weekStart: isoMonday(new Date()),
      });
      await logActivityBestEffort({
        workspaceId,
        eventType: "weekly_plan.created",
        entityType: "weekly_plan",
        entityId: plan.id,
        title: "Weekly plan created",
        description: `Week of ${plan.weekStart}.`,
      });
    }
    if (item.weeklyPlanId === plan.id) {
      // Already in the current plan — nothing to do (idempotent).
      return actionOk();
    }

    await movePlanItemToPlan({ workspaceId, itemId, weeklyPlanId: plan.id });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.carried_over",
      entityType: "weekly_plan_item",
      entityId: itemId,
      title: "Item carried over to the current week",
      description: `Moved into "${plan.title}" from a previous plan; status preserved (${item.status}).`,
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
    return actionOk();
  } catch (error) {
    if (error instanceof RepositoryError) return actionFail(error.message);
    console.error("[carryOverPlanItemAction] failed", error);
    return actionFail("Could not carry the item over. Try again.");
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

    const { listCreativesForItems, creativeReadinessReason } = await import(
      "@/repositories/weekly-plan-creative-repository"
    );
    const allCreatives = await listCreativesForItems(
      workspaceId,
      pendingItems.map((i) => i.id),
    );
    const creativesByItem = new Map<string, typeof allCreatives>();
    for (const c of allCreatives) {
      const arr = creativesByItem.get(c.weeklyPlanItemId) ?? [];
      arr.push(c);
      creativesByItem.set(c.weeklyPlanItemId, arr);
    }

    const warnings: string[] = [];
    const validItems = pendingItems.filter((it) => {
      const label = it.title ?? "Untitled";
      if (it.riskLevel === "blocked") {
        warnings.push(`Skipped "${label}" — risk level blocked.`);
        return false;
      }
      // Phase F1: only `post`-type items enter the publishing queue.
      // Comments stay as drafts; everything else is skipped explicitly.
      if (it.contentType !== "post") {
        warnings.push(
          `Skipped "${label}" — content_type='${it.contentType ?? "(none)"}' is not 'post'. Comments are draft-only in this version.`,
        );
        return false;
      }
      if (!it.scheduledAt) {
        warnings.push(
          `Skipped "${label}" — no scheduled_at. Set a date/time before approving.`,
        );
        return false;
      }
      const itemCreatives = creativesByItem.get(it.id) ?? [];
      const primaryCreative = selectPrimaryCreativeFromList(itemCreatives);
      const reason = creativeReadinessReason(primaryCreative);
      if (reason) {
        warnings.push(
          `Skipped "${label}" — creative not ready (${reason}).`,
        );
        return false;
      }
      if (it.accountId && !contract.scope.accountIds.includes(it.accountId)) {
        warnings.push(
          `Skipped "${label}" — account out of contract scope.`,
        );
        return false;
      }
      if (it.productId && !contract.scope.productIds.includes(it.productId)) {
        warnings.push(
          `Skipped "${label}" — product out of contract scope.`,
        );
        return false;
      }
      if (it.platform && !contract.scope.platforms.includes(it.platform)) {
        warnings.push(
          `Skipped "${label}" — platform out of contract scope.`,
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
        title: contract.title,
        weekStart: contract.weekStart,
        weekEnd: contract.weekEnd,
      });
    }

    // Transactional immediate-approval loop.
    //
    // Per item:
    //   1. Snapshot pre-mutation status + scheduled_at.
    //   2. Create execution_item (idempotency hint: source_entity_id
    //      is the plan_item_id; createExecutionItem is the canonical
    //      insert path).
    //   3. Walk it pending_authorization → authorized → scheduled.
    //   4. Update plan_item to 'scheduled'.
    //   5. Re-read the plan_item; assert status === 'scheduled' and
    //      scheduled_at unchanged.
    //   6. Emit observability for every step.
    let itemsApproved = 0;
    let executionItemsCreated = 0;
    const assertionFailures: string[] = [];
    for (const it of validItems) {
      const beforeStatus = it.status;
      const beforeScheduledAt = it.scheduledAt;
      emitApprovalTransitionStarted({
        action: "approve_weekly_plan",
        workspaceId,
        planId,
        planItemId: it.id,
        beforeStatus,
        beforeScheduledAt,
      });
      try {
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

        // Bump the plan_item to 'scheduled'.
        await updatePlanItemStatus({
          workspaceId,
          itemId: it.id,
          status: "scheduled",
        });

        // Verified DB re-read.
        const fresh = await getPlanItemById(workspaceId, it.id);
        const afterStatus = fresh.status;
        const afterScheduledAt = fresh.scheduledAt;
        if (afterStatus !== "scheduled") {
          assertionFailures.push(
            `"${it.title ?? it.id}" did not transition to scheduled (status=${afterStatus}).`,
          );
          emitApprovalStateAssertionFailed({
            action: "approve_weekly_plan",
            workspaceId,
            planId,
            planItemId: it.id,
            beforeStatus,
            afterStatus,
            beforeScheduledAt,
            afterScheduledAt,
            failureReason: `expected_status=scheduled actual=${afterStatus}`,
          });
          continue;
        }
        if (afterScheduledAt !== beforeScheduledAt) {
          assertionFailures.push(
            `"${it.title ?? it.id}" had its schedule mutated during immediate approval.`,
          );
          emitApprovalStateAssertionFailed({
            action: "approve_weekly_plan",
            workspaceId,
            planId,
            planItemId: it.id,
            beforeStatus,
            afterStatus,
            beforeScheduledAt,
            afterScheduledAt,
            failureReason: "scheduled_at mutated during immediate approval",
          });
          continue;
        }
        emitApprovalSchedulePreserved({
          action: "approve_weekly_plan",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeScheduledAt,
          afterScheduledAt,
        });
        emitApprovalTransitionCommitted({
          action: "approve_weekly_plan",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeStatus,
          afterStatus,
          beforeScheduledAt,
          afterScheduledAt,
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
      } catch (err) {
        const message = err instanceof Error ? err.message : "update_failed";
        assertionFailures.push(
          `"${it.title ?? it.id}" failed to approve (${message}).`,
        );
        emitApprovalTransitionFailed({
          action: "approve_weekly_plan",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeStatus,
          beforeScheduledAt,
          failureReason: message,
        });
      }
    }

    // If NO item made it through cleanly, surface a hard failure so
    // the UI doesn't render a false-success banner.
    if (itemsApproved === 0 && assertionFailures.length > 0) {
      return actionFail(
        `Approval failed: ${assertionFailures.slice(0, 3).join(" ")}`,
      );
    }
    for (const f of assertionFailures) warnings.push(f);

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

// =====================================================================
// approveAndHoldAction
// =====================================================================
//
// Companion to approveWeeklyPlanAction. Walks every pending_approval
// plan item to status='approved' WITHOUT creating an execution_item
// and WITHOUT requiring scheduled_at. Used when the operator wants
// to defer the scheduling decision — typically because Claude will
// schedule the item via signal.schedule_publish (MCP) after the
// approval.
//
// Contract:
//   - existing approve flow (approveWeeklyPlanAction) unchanged
//   - no execution_queue / execution_item touch
//   - no scheduled_at writes
//   - items without scheduled_at are still accepted (it can be set
//     later by the scheduler tool)
//   - creative readiness still enforced (an approved item without
//     creative would be a bad handoff)
//   - contract scope still enforced (no cross-scope approvals)

export type ApproveAndHoldResult = ActionResult<{
  planId: string;
  itemsApproved: number;
  warnings: string[];
}>;

export async function approveAndHoldAction(
  _prev: ApproveAndHoldResult,
  formData: FormData,
): Promise<ApproveAndHoldResult> {
  const planId = String(formData.get("plan_id") ?? "").trim();
  if (!planId) return actionFail("Missing plan id.");

  const { getActiveContract } = await import(
    "@/repositories/weekly-contract-repository"
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
      return actionFail("No items in pending_approval. Nothing to approve.");
    }

    const { listCreativesForItems, creativeReadinessReason } = await import(
      "@/repositories/weekly-plan-creative-repository"
    );
    const allCreatives = await listCreativesForItems(
      workspaceId,
      pendingItems.map((i) => i.id),
    );
    const creativesByItem = new Map<string, typeof allCreatives>();
    for (const c of allCreatives) {
      const arr = creativesByItem.get(c.weeklyPlanItemId) ?? [];
      arr.push(c);
      creativesByItem.set(c.weeklyPlanItemId, arr);
    }

    const warnings: string[] = [];
    const validItems = pendingItems.filter((it) => {
      const label = it.title ?? "Untitled";
      if (it.riskLevel === "blocked") {
        warnings.push(`Skipped "${label}" — risk level blocked.`);
        return false;
      }
      if (it.contentType !== "post") {
        warnings.push(
          `Skipped "${label}" — content_type='${it.contentType ?? "(none)"}' is not 'post'.`,
        );
        return false;
      }
      const itemCreatives = creativesByItem.get(it.id) ?? [];
      const primaryCreative = selectPrimaryCreativeFromList(itemCreatives);
      const reason = creativeReadinessReason(primaryCreative);
      if (reason) {
        warnings.push(
          `Skipped "${label}" — creative not ready (${reason}).`,
        );
        return false;
      }
      if (it.accountId && !contract.scope.accountIds.includes(it.accountId)) {
        warnings.push(`Skipped "${label}" — account out of contract scope.`);
        return false;
      }
      if (it.productId && !contract.scope.productIds.includes(it.productId)) {
        warnings.push(`Skipped "${label}" — product out of contract scope.`);
        return false;
      }
      if (it.platform && !contract.scope.platforms.includes(it.platform)) {
        warnings.push(`Skipped "${label}" — platform out of contract scope.`);
        return false;
      }
      return true;
    });

    if (validItems.length === 0) {
      return actionFail(
        `All ${pendingItems.length} pending item(s) failed contract-scope checks. ${warnings
          .slice(0, 3)
          .join(" ")}`,
      );
    }

    // Transactional approve-and-hold loop.
    //
    // For each valid item:
    //   1. Snapshot the original status + scheduled_at.
    //   2. Update status pending_approval → approved.
    //   3. Re-read the row from the DB.
    //   4. Assert the resulting status === 'approved' and the
    //      scheduled_at is byte-identical to the snapshot.
    //   5. On assertion failure, emit observability + push warning;
    //      surface as a failure when no item makes it through cleanly.
    let itemsApproved = 0;
    const assertionFailures: string[] = [];
    for (const it of validItems) {
      const beforeStatus = it.status;
      const beforeScheduledAt = it.scheduledAt;
      emitApprovalTransitionStarted({
        action: "approve_and_hold",
        workspaceId,
        planId,
        planItemId: it.id,
        beforeStatus,
        beforeScheduledAt,
      });
      try {
        await updatePlanItemStatus({
          workspaceId,
          itemId: it.id,
          status: "approved",
        });
        // Verified DB re-read — never trust the update call alone.
        const fresh = await getPlanItemById(workspaceId, it.id);
        const afterStatus = fresh.status;
        const afterScheduledAt = fresh.scheduledAt;
        if (afterStatus !== "approved") {
          assertionFailures.push(
            `"${it.title ?? it.id}" did not transition (status=${afterStatus}).`,
          );
          emitApprovalStateAssertionFailed({
            action: "approve_and_hold",
            workspaceId,
            planId,
            planItemId: it.id,
            beforeStatus,
            afterStatus,
            beforeScheduledAt,
            afterScheduledAt,
            failureReason: `expected_status=approved actual=${afterStatus}`,
          });
          continue;
        }
        if (afterScheduledAt !== beforeScheduledAt) {
          assertionFailures.push(
            `"${it.title ?? it.id}" had its schedule mutated during approve-and-hold.`,
          );
          emitApprovalStateAssertionFailed({
            action: "approve_and_hold",
            workspaceId,
            planId,
            planItemId: it.id,
            beforeStatus,
            afterStatus,
            beforeScheduledAt,
            afterScheduledAt,
            failureReason: "scheduled_at mutated during approve-and-hold",
          });
          continue;
        }
        emitApprovalSchedulePreserved({
          action: "approve_and_hold",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeScheduledAt,
          afterScheduledAt,
        });
        emitApprovalTransitionCommitted({
          action: "approve_and_hold",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeStatus,
          afterStatus,
          beforeScheduledAt,
          afterScheduledAt,
        });
        itemsApproved += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "update_failed";
        assertionFailures.push(
          `"${it.title ?? it.id}" failed to approve (${message}).`,
        );
        emitApprovalTransitionFailed({
          action: "approve_and_hold",
          workspaceId,
          planId,
          planItemId: it.id,
          beforeStatus,
          beforeScheduledAt,
          failureReason: message,
        });
      }
    }

    // If NO item made it through cleanly, surface a hard failure.
    // If some succeeded and some failed, return success with warnings.
    if (itemsApproved === 0 && assertionFailures.length > 0) {
      return actionFail(
        `Approval failed: ${assertionFailures.slice(0, 3).join(" ")}`,
      );
    }
    for (const f of assertionFailures) warnings.push(f);

    try {
      const { recordActivity } = await import(
        "@/repositories/activity-repository"
      );
      await recordActivity({
        workspaceId,
        eventType: "plan.approved_and_held",
        entityType: "weekly_plan",
        entityId: planId,
        title: `Approved ${itemsApproved} item${
          itemsApproved === 1 ? "" : "s"
        } — held for scheduling`,
        description:
          warnings.length > 0
            ? `${warnings.length} item(s) skipped — see warnings.`
            : "Items approved without scheduling. Schedule via signal.schedule_publish (MCP) or the existing approve flow.",
        metadata: { plan_id: planId, items_approved: itemsApproved },
      });
    } catch (err) {
      console.error("[approveAndHoldAction] activity log failed", err);
    }

    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    return actionOk({ planId, itemsApproved, warnings });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not approve and hold plan.";
    console.error("[approveAndHoldAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F6.2 — Bluesky-only operator-bound shape enforcement.
// =====================================================================
//
// The approval-time half of the shape-binding contract. Runs ONLY
// when item.platform === "bluesky". Never invoked for any other
// platform — keeps cross-platform isolation intact.
//
// Three return modes:
//   - { ok: true, intent: null }      → no enforcement (legacy item)
//   - { ok: true, intent: {...} }     → write platform_publish_intent
//                                       with new operatorApprovedShapeHash
//   - { ok: false, error: "…" }       → REFUSE approval; surface to operator
//
// This helper is intentionally inline-private — it never escapes the
// approval action surface, so future platform PRs can each ship
// their own equivalent without crossing boundaries.

async function bindBlueskyApprovalShapeOrRefuse(input: {
  platform: string | null;
  rawIntent: Record<string, unknown> | null;
  title: string | null;
  body: string | null;
  creative: {
    assetUrl: string | null;
    altText: string | null;
    sourceType: string;
  } | null;
}): Promise<
  | { ok: true; intent: Record<string, unknown> | null }
  | { ok: false; error: string }
> {
  // Hard isolation: this entire helper is a no-op for any platform
  // other than Bluesky. Other platforms remain in legacy mode.
  if (input.platform !== "bluesky") {
    return { ok: true, intent: null };
  }
  const decision = await decideBlueskyApprovalShape({
    rawIntent: input.rawIntent,
    title: input.title,
    body: input.body ?? "",
    creative: input.creative
      ? {
          assetUrl: input.creative.assetUrl,
          sourceUrl: null,
          altText: input.creative.altText,
          creativeType: input.creative.sourceType ?? "image",
        }
      : null,
  });
  if (decision.kind === "legacy_no_enforcement") {
    return { ok: true, intent: null };
  }
  if (decision.kind === "refuse") {
    const primary = decision.blockers[0];
    return {
      ok: false,
      error: `Bluesky approval blocked: ${primary.code} — ${primary.message}`,
    };
  }
  // kind === "bind"
  return { ok: true, intent: decision.serializedIntent };
}

// =====================================================================
// Per-item approval — approvePlanItemAndHoldAction
// =====================================================================
//
// Approves ONE plan item without scheduling. Reuses the shared
// readiness helper (assessItemApprovalReadiness) so blockers stay in
// lock-step with the bulk paths and the UI. Transactional pattern:
// snapshot → mutate → re-read → assert → observability.

export async function approvePlanItemAndHoldAction(
  _prev: ApprovePlanItemResult,
  formData: FormData,
): Promise<ApprovePlanItemResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const { updatePlanItemStatus } = await import(
    "@/repositories/weekly-plan-repository"
  );
  const { listCreativesForItems } = await import(
    "@/repositories/weekly-plan-creative-repository"
  );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getPlanItemById(workspaceId, itemId);
    // INVARIANT: per-item hold does NOT load or require a weekly
    // contract. Holding only flips status; no execution_item is
    // created, so the contract_id NOT NULL constraint on
    // execution_items doesn't apply. Bulk hold and immediate
    // scheduling still gate on contract.
    const allCreatives = await listCreativesForItems(workspaceId, [itemId]);
    const primaryCreative = selectPrimaryCreativeFromList(allCreatives);

    const readiness = assessItemApprovalReadiness({
      item,
      contract: null,
      primaryCreative,
      requireSchedule: false,
      requireContract: false,
    });
    if (!readiness.ready) {
      return actionFail(
        `Approval failed: ${readiness.blockers.slice(0, 2).join(" ")}`,
      );
    }

    // Phase F6.2 — Bluesky-only operator-bound shape enforcement.
    // No-op for every other platform. Refuses approval when the
    // operator's shape (e.g. single_only) conflicts with the
    // rendered payload. On success, binds operatorApprovedShapeHash.
    const shapeBinding = await bindBlueskyApprovalShapeOrRefuse({
      platform: item.platform,
      rawIntent: item.platformPublishIntent,
      title: item.title,
      body: item.body,
      creative: primaryCreative
        ? {
            assetUrl: primaryCreative.assetUrl,
            altText: primaryCreative.altText,
            sourceType: primaryCreative.sourceType,
          }
        : null,
    });
    if (!shapeBinding.ok) {
      return actionFail(shapeBinding.error);
    }

    const beforeStatus = item.status;
    const beforeScheduledAt = item.scheduledAt;
    emitApprovalTransitionStarted({
      action: "approve_and_hold",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      beforeScheduledAt,
    });

    // Persist the new approved-shape envelope BEFORE the status flip
    // so a stray race can never see status="approved" without the
    // bound hash. The status update is the canonical commit.
    if (shapeBinding.intent !== null) {
      await updatePlanItem({
        workspaceId,
        itemId: item.id,
        patch: {
          platform_publish_intent: shapeBinding.intent,
        },
      });
    }

    await updatePlanItemStatus({
      workspaceId,
      itemId: item.id,
      status: "approved",
    });

    const fresh = await getPlanItemById(workspaceId, item.id);
    if (fresh.status !== "approved") {
      emitApprovalStateAssertionFailed({
        action: "approve_and_hold",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: `expected_status=approved actual=${fresh.status}`,
      });
      return actionFail(
        "Approval failed: item remained in its previous status.",
      );
    }
    if (fresh.scheduledAt !== beforeScheduledAt) {
      emitApprovalStateAssertionFailed({
        action: "approve_and_hold",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: "scheduled_at mutated during approve-and-hold",
      });
      return actionFail(
        "Approval failed: schedule changed unexpectedly during approval.",
      );
    }
    emitApprovalSchedulePreserved({
      action: "approve_and_hold",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });
    emitApprovalTransitionCommitted({
      action: "approve_and_hold",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      afterStatus: fresh.status,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.approved_and_held",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Approved (held) "${item.title ?? "Untitled"}"`,
      description: "Item approved without scheduling.",
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    return actionOk({
      itemId: item.id,
      status: "approved",
      scheduledAtIso: fresh.scheduledAt,
      executionItemId: null,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not approve this item.";
    console.error("[approvePlanItemAndHoldAction] failed", error);
    emitApprovalTransitionFailed({
      action: "approve_and_hold",
      workspaceId: "",
      planItemId: itemId,
      failureReason: message,
    });
    return actionFail(message);
  }
}

// =====================================================================
// Per-item approval — approvePlanItemAndScheduleAction
// =====================================================================
//
// Approves ONE plan item AND schedules it immediately using its
// existing scheduled_at. Creates exactly one execution_item (refuses
// if one already exists for this plan_item), walks it through
// pending_authorization → authorized → scheduled, then bumps the
// plan_item to "scheduled".

export async function approvePlanItemAndScheduleAction(
  _prev: ApprovePlanItemResult,
  formData: FormData,
): Promise<ApprovePlanItemResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const { getActiveContract } = await import(
    "@/repositories/weekly-contract-repository"
  );
  const { updatePlanItemStatus } = await import(
    "@/repositories/weekly-plan-repository"
  );
  const { listCreativesForItems } = await import(
    "@/repositories/weekly-plan-creative-repository"
  );
  const {
    getActiveExecutionQueue,
    getActiveContractFreeExecutionQueue,
    createExecutionQueue,
  } = await import("@/repositories/execution-queue-repository");
  const {
    createExecutionItem,
    listExecutionItemsByPlanItemIds,
    updateItemStatus,
  } = await import("@/repositories/execution-item-repository");
  const { recordLog } = await import(
    "@/repositories/execution-log-repository"
  );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getPlanItemById(workspaceId, itemId);
    // Active contract is OPTIONAL post-migration. When attached, we
    // record contract_id on the execution_item and apply scope
    // checks. When absent, we use the workspace's contract-free
    // execution queue (or create one).
    const contract = await getActiveContract(workspaceId);
    const allCreatives = await listCreativesForItems(workspaceId, [itemId]);
    const primaryCreative = selectPrimaryCreativeFromList(allCreatives);

    const readiness = assessItemApprovalReadiness({
      item,
      contract,
      primaryCreative,
      requireSchedule: true,
      // Per-post immediate-schedule no longer requires an active
      // weekly contract. When one IS present, the readiness helper
      // still runs scope checks (requireContract: true). When absent,
      // we skip both (requireContract: false).
      requireContract: contract !== null,
    });
    if (!readiness.ready) {
      return actionFail(
        `Approval failed: ${readiness.blockers.slice(0, 2).join(" ")}`,
      );
    }

    // Phase F6.2 — Bluesky-only operator-bound shape enforcement.
    // No-op for every other platform. Runs BEFORE the duplicate-
    // execution-item check so a stale-shape refusal doesn't waste a
    // queue lookup.
    const shapeBinding = await bindBlueskyApprovalShapeOrRefuse({
      platform: item.platform,
      rawIntent: item.platformPublishIntent,
      title: item.title,
      body: item.body,
      creative: primaryCreative
        ? {
            assetUrl: primaryCreative.assetUrl,
            altText: primaryCreative.altText,
            sourceType: primaryCreative.sourceType,
          }
        : null,
    });
    if (!shapeBinding.ok) {
      return actionFail(shapeBinding.error);
    }

    // Duplicate-prevention: refuse if an execution_item already
    // points at this plan_item.
    const existingExec = await listExecutionItemsByPlanItemIds(workspaceId, [
      itemId,
    ]);
    if (existingExec.length > 0) {
      return actionFail(
        "Approval failed: this item already has an execution_item — refusing to create a duplicate.",
      );
    }

    // Queue selection — branch on whether a contract is attached.
    // Contract path: reuse / create the contract-bound queue.
    // Contract-free path: reuse / create the workspace contract-free
    // queue (one live row at a time per workspace; the unique partial
    // index on contract_id ignores NULL so we may have several, but
    // this lookup picks the most recently created live one).
    let queue;
    if (contract) {
      queue = await getActiveExecutionQueue(workspaceId, contract.id);
      if (!queue) {
        queue = await createExecutionQueue({
          workspaceId,
          contractId: contract.id,
          title: contract.title,
          weekStart: contract.weekStart,
          weekEnd: contract.weekEnd,
        });
      }
    } else {
      queue = await getActiveContractFreeExecutionQueue(workspaceId);
      if (!queue) {
        const todayIso = new Date().toISOString().slice(0, 10);
        // 90-day horizon — the queue is reusable for all
        // contract-free items scheduled in the next quarter.
        const endIso = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        queue = await createExecutionQueue({
          workspaceId,
          contractId: null,
          title: "Contract-free items",
          weekStart: todayIso,
          weekEnd: endIso,
        });
      }
    }

    const beforeStatus = item.status;
    const beforeScheduledAt = item.scheduledAt;
    emitApprovalTransitionStarted({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      beforeScheduledAt,
    });

    const execItem = await createExecutionItem({
      workspaceId,
      queueId: queue.id,
      contractId: contract ? contract.id : null,
      actionType:
        item.contentType === "comment"
          ? "publish_scheduled_comment"
          : "publish_scheduled_post",
      sourceEntityType: "weekly_plan_item",
      sourceEntityId: item.id,
      productId: item.productId,
      accountId: item.accountId,
      platform: item.platform,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
      scheduledAt: item.scheduledAt,
      riskScore: item.riskScore,
      riskLevel: item.riskLevel,
      metadata: {
        plan_item_id: item.id,
        plan_id: item.weeklyPlanId,
        source: "approve_plan_item_and_schedule",
        // Audit-trail flags so future readers (and dashboards) can
        // see whether the item was scheduled under a contract or
        // without one.
        contract_mode: contract ? "contract_attached" : "contract_free_item",
        approval_mode: "per_item",
        approved_without_contract: contract === null,
      },
    });
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
    // Persist the bound shape (Bluesky-only; no-op for other
    // platforms) BEFORE the canonical plan_item status flip.
    if (shapeBinding.intent !== null) {
      await updatePlanItem({
        workspaceId,
        itemId: item.id,
        patch: {
          platform_publish_intent: shapeBinding.intent,
        },
      });
    }
    await updatePlanItemStatus({
      workspaceId,
      itemId: item.id,
      status: "scheduled",
    });

    const fresh = await getPlanItemById(workspaceId, item.id);
    if (fresh.status !== "scheduled") {
      emitApprovalStateAssertionFailed({
        action: "approve_weekly_plan",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: `expected_status=scheduled actual=${fresh.status}`,
      });
      return actionFail(
        "Approval failed: item did not transition to scheduled.",
      );
    }
    if (fresh.scheduledAt !== beforeScheduledAt) {
      emitApprovalStateAssertionFailed({
        action: "approve_weekly_plan",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: "scheduled_at mutated during immediate approval",
      });
      return actionFail(
        "Approval failed: schedule changed unexpectedly during approval.",
      );
    }
    emitApprovalSchedulePreserved({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });
    emitApprovalTransitionCommitted({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      afterStatus: fresh.status,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });

    await recordLog({
      workspaceId,
      queueId: queue.id,
      executionItemId: execItem.id,
      eventType: "item.scheduled",
      severity: "info",
      message: `Per-item approval scheduled "${item.title ?? "Untitled"}" for ${item.scheduledAt ?? "(immediate)"}`,
      metadata: { plan_item_id: item.id, plan_id: item.weeklyPlanId },
    });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.approved_and_scheduled",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Approved + scheduled "${item.title ?? "Untitled"}"`,
      description: `Scheduled for ${item.scheduledAt ?? "(immediate)"}.`,
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/execution");
    revalidatePath(`/execution/${queue.id}`);
    revalidatePath("/activity");
    return actionOk({
      itemId: item.id,
      status: "scheduled",
      scheduledAtIso: fresh.scheduledAt,
      executionItemId: execItem.id,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not approve and schedule this item.";
    console.error("[approvePlanItemAndScheduleAction] failed", error);
    emitApprovalTransitionFailed({
      action: "approve_weekly_plan",
      workspaceId: "",
      planItemId: itemId,
      failureReason: message,
    });
    return actionFail(message);
  }
}

// =====================================================================
// Phase F7.2 — cancelApprovalAction
// =====================================================================
//
// Reverts an `approved` or `scheduled` plan_item back to
// `pending_approval` so the operator can edit / drop / re-think
// before publishing. Real-world trigger: circumstances change after
// approval (content stale, change of mind, edits needed). Without
// this action the operator had to wait for the scheduled publish
// to fail / be paused, or fall back to admin-shaped Supabase edits.
//
// Allowed transitions
// -------------------
//   approved                                → pending_approval
//   scheduled (+ execution_item not yet running / not completed)
//                                           → pending_approval
//                                            + execution_item.status = cancelled
//
// Refused
// -------
//   published / rejected / paused / skipped / backlog / draft /
//   pending_approval → caller already at terminal state OR has no
//   approval to cancel. Returned with an actionable message.
//
//   scheduled + execution_item.status='running' → publish is in
//   flight, so cancellation could race with the provider call.
//   Refused; operator waits for the tick to finish.
//
//   scheduled + execution_item.status='completed' → the publish
//   already succeeded; revert is impossible. Refused.
//
// Race safety
// -----------
// The execution_item cancel uses an atomic `UPDATE ... WHERE
// status IN (cancellable_set)` so a scheduler tick that picks up
// the row between our status check and the cancel write cannot
// produce inconsistent state. The repository's `updateItemStatus`
// applies the WHERE filter for us; here we additionally pin the
// from-status set explicitly.
//
// Operator-only / cookie-session protected — mirrors the other
// approval actions. No MCP bypass.

/**
 * Execution-item states that can be safely flipped to `cancelled` by
 * this operator action. Strictly pre-dispatch + manual-publish-ready;
 * anything past this point either succeeded, failed terminally, or
 * is in the operator's hands already (paused / blocked / backlogged
 * / skipped). The `cancelled` status is its own no-op.
 */
const CANCELLABLE_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "pending_authorization",
  "authorized",
  "scheduled",
  "ready",
  "ready_for_manual_publish",
]);

/**
 * Execution-item states the operator must NOT race against (running)
 * or that are already finished (completed). Surfacing either of
 * these for a plan_item still in `scheduled` is rare but possible
 * if the scheduler tick is mid-flight; refuse so we don't double-
 * publish or paper over a successful publish.
 */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
]);

export async function cancelApprovalAction(
  _prev: CancelApprovalResult,
  formData: FormData,
): Promise<CancelApprovalResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const { updatePlanItemStatus } = await import(
    "@/repositories/weekly-plan-repository"
  );
  const { listExecutionItemsByPlanItemIds } = await import(
    "@/repositories/execution-item-repository"
  );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getPlanItemById(workspaceId, itemId);

    // Gate on plan-item status. Only approved / scheduled have
    // approval state TO cancel.
    if (item.status !== "approved" && item.status !== "scheduled") {
      const friendly =
        item.status === "published"
          ? "This item has already been published — cancellation is no longer possible."
          : item.status === "rejected"
            ? "This item has been rejected; there's no approval to cancel."
            : item.status === "paused" || item.status === "skipped"
              ? "This item is not currently approved. Edit it and approve again to publish."
              : "There's no approved state to cancel on this item.";
      return actionFail(friendly);
    }

    // Find any execution_items for this plan_item. The
    // approved-and-held path won't have any; the scheduled path
    // typically has one in pending_authorization / authorized /
    // scheduled. We cancel any that are still cancellable; refuse
    // if any has progressed to running or completed.
    const execItems = await listExecutionItemsByPlanItemIds(workspaceId, [
      itemId,
    ]);
    const terminal = execItems.find((e) =>
      TERMINAL_EXECUTION_STATUSES.has(e.status),
    );
    if (terminal) {
      return actionFail(
        terminal.status === "running"
          ? "A publish is in flight for this item. Wait for it to finish, then try again."
          : "This item has already been published — cancellation is no longer possible.",
      );
    }

    // Cancel each cancellable execution_item via the supabase
    // service-role-aware client. We use a direct atomic UPDATE so
    // the from-status filter is enforced at the DB layer.
    const { createSupabaseServerClient } = await import("@/lib/supabase");
    const supabase = createSupabaseServerClient();
    let cancelledExecutionItemCount = 0;
    for (const exec of execItems) {
      if (!CANCELLABLE_EXECUTION_STATUSES.has(exec.status)) continue;
      const { data: cancelled, error } = await supabase
        .from("execution_items")
        .update({ status: "cancelled" } as never)
        .eq("workspace_id", workspaceId)
        .eq("id", exec.id)
        .in("status", Array.from(CANCELLABLE_EXECUTION_STATUSES))
        .select("id, status")
        .maybeSingle();
      if (error) {
        return actionFail(
          "Could not cancel the scheduled execution. Try again in a few seconds.",
        );
      }
      if (cancelled) {
        cancelledExecutionItemCount += 1;
      }
    }

    // Now flip the plan_item back to pending_approval. We keep it
    // editable but not yet ready for publish.
    await updatePlanItemStatus({
      workspaceId,
      itemId: item.id,
      status: "pending_approval",
    });

    const fresh = await getPlanItemById(workspaceId, item.id);
    if (fresh.status !== "pending_approval") {
      return actionFail(
        "Cancellation failed: item did not transition back to pending_approval.",
      );
    }

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.approval_cancelled",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Approval cancelled for "${item.title ?? "Untitled"}"`,
      description:
        cancelledExecutionItemCount > 0
          ? `Reverted to pending_approval; cancelled ${cancelledExecutionItemCount} pending execution(s).`
          : "Reverted to pending_approval.",
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/execution");
    revalidatePath("/activity");
    return actionOk({
      itemId: item.id,
      status: "pending_approval",
      cancelledExecutionItemCount,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not cancel approval.";
    console.error("[cancelApprovalAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// scheduleApprovedItemAction — schedule an already-approved item
// =====================================================================
//
// Closes the gap between `approvePlanItemAndHoldAction` (which leaves
// the item in `approved` without an execution_item) and the
// scheduler (which only publishes execution_items). Before this
// action, an operator who chose Approve & Hold and then tried to set
// a publish time via the modal's Schedule input would only update
// `weekly_plan_items.scheduled_at` — no execution_item was ever
// created, and the post never published.
//
// This action takes an item that is ALREADY in status=approved,
// validates the same readiness gates as the per-item schedule path,
// creates the execution_item, walks it to `scheduled`, and flips the
// plan_item to `scheduled`. Same transactional re-read + assertion
// pattern as the other approval actions. Contract-aware: works with
// or without an active weekly contract (post-migration
// 20260605000001_contract_free_per_post_publishing.sql).
//
// MCP `signal.schedule_publish` already supports both
// `pending_approval` and `approved` items because it inlines its own
// logic. This UI-facing action mirrors that behavior.

export async function scheduleApprovedItemAction(
  _prev: ApprovePlanItemResult,
  formData: FormData,
): Promise<ApprovePlanItemResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const { getActiveContract } = await import(
    "@/repositories/weekly-contract-repository"
  );
  const { updatePlanItemStatus } = await import(
    "@/repositories/weekly-plan-repository"
  );
  const { listCreativesForItems } = await import(
    "@/repositories/weekly-plan-creative-repository"
  );
  const {
    getActiveExecutionQueue,
    getActiveContractFreeExecutionQueue,
    createExecutionQueue,
  } = await import("@/repositories/execution-queue-repository");
  const {
    createExecutionItem,
    listExecutionItemsByPlanItemIds,
    updateItemStatus,
  } = await import("@/repositories/execution-item-repository");
  const { recordLog } = await import(
    "@/repositories/execution-log-repository"
  );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const item = await getPlanItemById(workspaceId, itemId);
    const contract = await getActiveContract(workspaceId);
    const allCreatives = await listCreativesForItems(workspaceId, [itemId]);
    const primaryCreative = selectPrimaryCreativeFromList(allCreatives);

    const readiness = assessItemApprovalReadiness({
      item,
      contract,
      primaryCreative,
      requireSchedule: true,
      requireContract: contract !== null,
      // Accept items past the approval gate: `approved` (never
      // scheduled before) and `paused` (the scheduler mirrors
      // execution_item.blocked/failed back to plan_item.paused;
      // those items are recoverable — creative + alt + schedule
      // are intact).
      allowedStatuses: ["approved", "paused"],
    });
    if (!readiness.ready) {
      return actionFail(
        `Schedule failed: ${readiness.blockers.slice(0, 2).join(" ")}`,
      );
    }

    // Duplicate-prevention: refuse only when an ACTIVE execution_item
    // exists for this plan_item. Terminal rows (blocked, failed,
    // completed, cancelled, backlogged) are history and must not
    // block a retry. This is what enables the paused→scheduled
    // recovery path.
    const ACTIVE_EXECUTION_STATUSES = new Set([
      "pending_authorization",
      "authorized",
      "scheduled",
      "ready",
      "running",
    ]);
    const allExec = await listExecutionItemsByPlanItemIds(workspaceId, [
      itemId,
    ]);
    const activeExec = allExec.filter((e) =>
      ACTIVE_EXECUTION_STATUSES.has(e.status),
    );
    if (activeExec.length > 0) {
      return actionFail(
        "Schedule failed: this item already has an active execution_item — refusing to create a duplicate.",
      );
    }
    const previousExec =
      allExec.length > 0 ? allExec[allExec.length - 1] : null;

    // Queue selection — same branching as approvePlanItemAndScheduleAction.
    let queue;
    if (contract) {
      queue = await getActiveExecutionQueue(workspaceId, contract.id);
      if (!queue) {
        queue = await createExecutionQueue({
          workspaceId,
          contractId: contract.id,
          title: contract.title,
          weekStart: contract.weekStart,
          weekEnd: contract.weekEnd,
        });
      }
    } else {
      queue = await getActiveContractFreeExecutionQueue(workspaceId);
      if (!queue) {
        const todayIso = new Date().toISOString().slice(0, 10);
        const endIso = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        queue = await createExecutionQueue({
          workspaceId,
          contractId: null,
          title: "Contract-free items",
          weekStart: todayIso,
          weekEnd: endIso,
        });
      }
    }

    const beforeStatus = item.status;
    const beforeScheduledAt = item.scheduledAt;
    emitApprovalTransitionStarted({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      beforeScheduledAt,
    });

    const execItem = await createExecutionItem({
      workspaceId,
      queueId: queue.id,
      contractId: contract ? contract.id : null,
      actionType:
        item.contentType === "comment"
          ? "publish_scheduled_comment"
          : "publish_scheduled_post",
      sourceEntityType: "weekly_plan_item",
      sourceEntityId: item.id,
      productId: item.productId,
      accountId: item.accountId,
      platform: item.platform,
      title: item.title,
      body: item.body,
      linkUrl: item.linkUrl,
      scheduledAt: item.scheduledAt,
      riskScore: item.riskScore,
      riskLevel: item.riskLevel,
      metadata: {
        plan_item_id: item.id,
        plan_id: item.weeklyPlanId,
        source: "schedule_approved_item",
        contract_mode: contract ? "contract_attached" : "contract_free_item",
        approval_mode: "per_item",
        approved_without_contract: contract === null,
        // Retry audit trail — when the plan_item came in as "paused"
        // (or another non-approved-but-allowed status), record what
        // we recovered from and the prior execution_item id so the
        // history is traceable.
        rescheduled_from_status:
          item.status !== "approved" ? item.status : undefined,
        previous_execution_item_id: previousExec?.id ?? undefined,
        previous_execution_item_status: previousExec?.status ?? undefined,
      },
    });
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
    await updatePlanItemStatus({
      workspaceId,
      itemId: item.id,
      status: "scheduled",
    });

    const fresh = await getPlanItemById(workspaceId, item.id);
    if (fresh.status !== "scheduled") {
      emitApprovalStateAssertionFailed({
        action: "approve_weekly_plan",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: `expected_status=scheduled actual=${fresh.status}`,
      });
      return actionFail(
        "Schedule failed: item did not transition to scheduled.",
      );
    }
    if (fresh.scheduledAt !== beforeScheduledAt) {
      emitApprovalStateAssertionFailed({
        action: "approve_weekly_plan",
        workspaceId,
        planId: item.weeklyPlanId,
        planItemId: item.id,
        beforeStatus,
        afterStatus: fresh.status,
        beforeScheduledAt,
        afterScheduledAt: fresh.scheduledAt,
        failureReason: "scheduled_at mutated during schedule transition",
      });
      return actionFail(
        "Schedule failed: schedule changed unexpectedly during scheduling.",
      );
    }
    emitApprovalSchedulePreserved({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });
    emitApprovalTransitionCommitted({
      action: "approve_weekly_plan",
      workspaceId,
      planId: item.weeklyPlanId,
      planItemId: item.id,
      beforeStatus,
      afterStatus: fresh.status,
      beforeScheduledAt,
      afterScheduledAt: fresh.scheduledAt,
    });

    await recordLog({
      workspaceId,
      queueId: queue.id,
      executionItemId: execItem.id,
      eventType: "item.scheduled",
      severity: "info",
      message: `Approved item scheduled "${item.title ?? "Untitled"}" for ${item.scheduledAt ?? "(immediate)"}`,
      metadata: { plan_item_id: item.id, plan_id: item.weeklyPlanId },
    });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.scheduled",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Scheduled "${item.title ?? "Untitled"}"`,
      description: `Scheduled for ${item.scheduledAt ?? "(immediate)"}.`,
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/execution");
    revalidatePath(`/execution/${queue.id}`);
    revalidatePath("/activity");
    return actionOk({
      itemId: item.id,
      status: "scheduled",
      scheduledAtIso: fresh.scheduledAt,
      executionItemId: execItem.id,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not schedule this approved item.";
    console.error("[scheduleApprovedItemAction] failed", error);
    emitApprovalTransitionFailed({
      action: "approve_weekly_plan",
      workspaceId: "",
      planItemId: itemId,
      failureReason: message,
    });
    return actionFail(message);
  }
}

// =====================================================================
// Phase F1 — updatePlanItemAction (inline edit)
// =====================================================================
//
// Permits editing title/body/platform/content_type/product_id/account_id/
// scheduled_at/risk_score/notes/status. Status changes are restricted
// to draft / pending_approval / skipped — UI cannot promote an item to
// approved / scheduled / published from here. Use the approval action
// or the approveWeeklyPlanAction for those.

const EDITABLE_STATUS_VALUES = new Set([
  "draft",
  "pending_approval",
  "skipped",
] as const);

type EditableStatus = "draft" | "pending_approval" | "skipped";

function parseEditableStatus(raw: string | null): EditableStatus | null {
  if (!raw) return null;
  return EDITABLE_STATUS_VALUES.has(raw as EditableStatus)
    ? (raw as EditableStatus)
    : null;
}

function parseRiskScore(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n;
}

function parseScheduledAt(raw: string | null): string | null | undefined {
  // Used by updatePlanItemAction (quick reschedule popover) and other
  // legacy callers. Requires a fully-qualified ISO timestamp so we never
  // re-interpret a bare datetime-local string in the server's local
  // zone. The client always converts to ISO via datetimeLocalToIso
  // before submitting.
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (!hasTz) return undefined;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export async function updatePlanItemAction(
  _prev: UpdatePlanItemResult,
  formData: FormData,
): Promise<UpdatePlanItemResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Item id is required.");

  const patch: WeeklyPlanItemUpdate = {};
  const meta: Record<string, unknown> = {};

  // Title is required if provided; null-out only if explicitly empty.
  const titleRaw = formData.get("title");
  if (titleRaw !== null) {
    const t = String(titleRaw).trim();
    if (t.length === 0) return actionFail("Title cannot be empty.");
    patch.title = t;
  }

  const bodyRaw = formData.get("body");
  if (bodyRaw !== null) {
    const b = String(bodyRaw);
    patch.body = b.length === 0 ? null : b;
  }

  const platformRaw = formData.get("platform");
  if (platformRaw !== null) {
    const p = String(platformRaw).trim();
    patch.platform = p.length === 0 ? null : p;
  }

  const contentTypeRaw = formData.get("content_type");
  if (contentTypeRaw !== null) {
    const c = String(contentTypeRaw).trim();
    patch.content_type = c.length === 0 ? null : c;
  }

  const productIdRaw = formData.get("product_id");
  if (productIdRaw !== null) {
    const v = String(productIdRaw).trim();
    patch.product_id = v.length === 0 ? null : v;
  }

  const accountIdRaw = formData.get("account_id");
  if (accountIdRaw !== null) {
    const v = String(accountIdRaw).trim();
    patch.account_id = v.length === 0 ? null : v;
  }

  const scheduledAtParsed = parseScheduledAt(
    formData.get("scheduled_at") as string | null,
  );
  if (scheduledAtParsed === undefined && formData.has("scheduled_at")) {
    return actionFail("Could not parse scheduled date/time.");
  }
  if (scheduledAtParsed !== undefined) {
    patch.scheduled_at = scheduledAtParsed;
  }

  const riskScoreParsed = parseRiskScore(
    formData.get("risk_score") as string | null,
  );
  if (riskScoreParsed === undefined && formData.has("risk_score")) {
    return actionFail("Risk score must be a number 0–100.");
  }
  if (riskScoreParsed !== undefined) {
    patch.risk_score = riskScoreParsed;
  }

  const statusRaw = formData.get("status") as string | null;
  if (statusRaw !== null && statusRaw !== "") {
    const status = parseEditableStatus(statusRaw);
    if (!status) {
      return actionFail(
        "Status from the edit UI can only be draft, pending_approval, or skipped.",
      );
    }
    patch.status = status;
  }

  const notesRaw = formData.get("notes");
  if (notesRaw !== null) {
    const n = String(notesRaw).trim();
    if (n.length > 0) meta.operator_notes = n;
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    if (Object.keys(meta).length > 0) {
      const existing = await getPlanItemById(membership.workspace.id, itemId);
      patch.metadata = { ...existing.metadata, ...meta };
    }

    const updated = await updatePlanItem({
      workspaceId: membership.workspace.id,
      itemId,
      patch,
    });

    // If the reschedule popover (or any other patch on this action)
    // changed scheduled_at, mirror it onto the active execution_item
    // so the scheduler tick picks up the new time. No-op when
    // scheduled_at was not in the patch.
    let resyncBlockerMessage: string | null = null;
    if (patch.scheduled_at !== undefined) {
      const { resyncActiveExecutionItemSchedule } = await import(
        "@/core/scheduling/resync-execution-item-schedule.server"
      );
      const resyncOutcome = await resyncActiveExecutionItemSchedule({
        workspaceId: membership.workspace.id,
        planItemId: itemId,
        nextScheduledAtIso: patch.scheduled_at as string | null,
        source: "ui",
      });
      if (resyncOutcome.mode === "blocked" && resyncOutcome.message) {
        resyncBlockerMessage = resyncOutcome.message;
      }
    }

    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_plan_item.edited",
      entityType: "weekly_plan_item",
      entityId: updated.id,
      title: `Item "${updated.title ?? "Untitled"}" edited`,
      description: Object.keys(patch)
        .filter((k) => k !== "metadata")
        .join(", "),
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/activity");
    if (resyncBlockerMessage) {
      // Plan-item write succeeded but the active execution_item can't
      // be moved (running/paused/failed/terminal). Surface the recovery
      // instruction without rolling back the plan-item edit.
      return actionFail(resyncBlockerMessage);
    }
    return actionOk({ itemId: updated.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
        ? error.message
        : "Could not update plan item.";
    console.error("[updatePlanItemAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F1 — attachCreativeAction
// =====================================================================
//
// Attaches (or updates) a creative on a plan item. Supports the six
// source types from the policy. If a `creative_id` is supplied, the
// existing row is updated; otherwise a new row is inserted.

const CREATIVE_TYPE_VALUES = new Set([
  "image",
  "video",
  "animation",
] as const);

const CREATIVE_SOURCE_TYPE_VALUES = new Set([
  "generated",
  "uploaded",
  "wikimedia",
  "official_source",
  "manual_url",
  "planned",
] as const);

export async function attachCreativeAction(
  _prev: AttachCreativeResult,
  formData: FormData,
): Promise<AttachCreativeResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Item id is required.");

  const creativeIdRaw = String(formData.get("creative_id") ?? "").trim();
  const creativeId = creativeIdRaw.length > 0 ? creativeIdRaw : null;

  const creativeType = String(formData.get("creative_type") ?? "").trim();
  if (!CREATIVE_TYPE_VALUES.has(creativeType as CreativeType)) {
    return actionFail("Creative type must be image, video, or animation.");
  }

  const sourceType = String(formData.get("source_type") ?? "").trim();
  if (!CREATIVE_SOURCE_TYPE_VALUES.has(sourceType as CreativeSourceType)) {
    return actionFail(
      "Source type must be one of: generated, uploaded, wikimedia, official_source, manual_url, planned.",
    );
  }

  const sourceUrl = String(formData.get("source_url") ?? "").trim() || null;
  const assetUrl = String(formData.get("asset_url") ?? "").trim() || null;
  const prompt = String(formData.get("prompt") ?? "").trim() || null;
  const altText = String(formData.get("alt_text") ?? "").trim() || null;
  const license = String(formData.get("license") ?? "").trim() || null;
  const attribution =
    String(formData.get("attribution") ?? "").trim() || null;
  const riskNotes = String(formData.get("risk_notes") ?? "").trim() || null;
  // Operator may opt to approve directly via the form. UI ships an
  // explicit "Approve creative" checkbox so non-uploaded external
  // assets still get a deliberate ack.
  const approveNow = formData.get("approve_now") === "on";

  // Light source-specific validation. Hard rules live in
  // creativeReadinessReason; we only block the obviously-wrong here.
  if (sourceType === "wikimedia" || sourceType === "manual_url") {
    if (!sourceUrl) {
      return actionFail(
        "External sources (wikimedia / manual_url) require a source URL.",
      );
    }
  }
  if (sourceType === "generated" && !prompt) {
    return actionFail("Generated creatives require a prompt.");
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const workspaceId = membership.workspace.id;

    if (creativeId) {
      const existing = await getCreativeById(workspaceId, creativeId);
      if (existing.weeklyPlanItemId !== itemId) {
        return actionFail("Creative does not belong to this item.");
      }
      const updated = await updateCreative({
        workspaceId,
        creativeId: existing.id,
        patch: {
          creative_type: creativeType as CreativeType,
          source_type: sourceType as CreativeSourceType,
          source_url: sourceUrl,
          asset_url: assetUrl,
          prompt,
          alt_text: altText,
          license,
          attribution,
          risk_notes: riskNotes,
          ...(approveNow ? { status: "approved" as const } : {}),
        },
      });
      await logActivityBestEffort({
        workspaceId,
        eventType: "weekly_plan_item.creative_updated",
        entityType: "weekly_plan_item_creative",
        entityId: updated.id,
        title: `Creative updated (${updated.creativeType} · ${updated.sourceType})`,
      });
      revalidatePath("/weekly-plan");
      return actionOk({ creativeId: updated.id });
    }

    const created = await createCreative({
      workspaceId,
      weeklyPlanItemId: itemId,
      creativeType: creativeType as CreativeType,
      sourceType: sourceType as CreativeSourceType,
      sourceUrl,
      assetUrl,
      prompt,
      altText,
      license,
      attribution,
      riskNotes,
      status:
        sourceType === "planned"
          ? "planned"
          : approveNow
            ? "approved"
            : "pending_review",
    });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.creative_attached",
      entityType: "weekly_plan_item_creative",
      entityId: created.id,
      title: `Creative attached (${created.creativeType} · ${created.sourceType})`,
    });
    revalidatePath("/weekly-plan");
    return actionOk({ creativeId: created.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
        ? error.message
        : "Could not attach creative.";
    console.error("[attachCreativeAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F2.5 — uploadCreativeAssetAction (file → Supabase Storage)
// =====================================================================
//
// Validates MIME + size, generates a random filename, uploads to the
// public bucket under `<workspace_id>/<plan_item_id>/<uuid>.<ext>`,
// and either creates or updates the creative row with the public
// URL + upload metadata. Auth-required (the route runs server-only
// and the supabase client reads the cookie session).

export async function uploadCreativeAssetAction(
  _prev: UploadCreativeAssetResult,
  formData: FormData,
): Promise<UploadCreativeAssetResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Item id is required.");
  const creativeIdRaw = String(formData.get("creative_id") ?? "").trim();
  const creativeIdInput = creativeIdRaw.length > 0 ? creativeIdRaw : null;
  const file = formData.get("file");
  if (!(file instanceof File)) return actionFail("No file uploaded.");

  const { createSupabaseServerClient } = await import("@/lib/supabase");
  const { validateUpload, extensionForMime, creativeTypeForMime } =
    await import("@/core/publishing/creative-upload-policy");
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return actionFail("Not authenticated.");

  const validation = validateUpload({
    mime: file.type,
    sizeBytes: file.size,
  });
  if (!validation.ok) return actionFail(validation.reason!);

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    // Confirm the item belongs to this workspace.
    const existing = await getPlanItemById(workspaceId, itemId);
    if (!existing) return actionFail("Item not found.");

    const { randomUUID } = await import("node:crypto");
    const mime = file.type as AllowedMime;
    const ext = extensionForMime(mime);
    const objectName = `${workspaceId}/${itemId}/${randomUUID()}.${ext}`;

    const buf = Buffer.from(await file.arrayBuffer());
    const upload = await supabase.storage
      .from("weekly-plan-creatives")
      .upload(objectName, buf, {
        contentType: mime,
        cacheControl: "3600",
        upsert: false,
      });
    if (upload.error) {
      return actionFail(`Upload failed: ${upload.error.message}`);
    }

    const { data: pub } = supabase.storage
      .from("weekly-plan-creatives")
      .getPublicUrl(objectName);
    const assetUrl = pub.publicUrl;

    let creative;
    if (creativeIdInput) {
      creative = await getCreativeById(workspaceId, creativeIdInput);
      if (creative.weeklyPlanItemId !== itemId) {
        return actionFail("Creative does not belong to this item.");
      }
      creative = await updateCreative({
        workspaceId,
        creativeId: creative.id,
        patch: {
          creative_type: creativeTypeForMime(mime),
          source_type: "uploaded",
          asset_url: assetUrl,
          storage_path: objectName,
          mime_type: mime,
          size_bytes: file.size,
          uploaded_by: user.id,
          uploaded_at: new Date().toISOString(),
          // Uploaded by the operator → jump to approved automatically.
          // External URLs go through a separate review flow.
          status: "approved",
        },
      });
    } else {
      creative = await createCreative({
        workspaceId,
        weeklyPlanItemId: itemId,
        creativeType: creativeTypeForMime(mime),
        sourceType: "uploaded",
        assetUrl,
        status: "approved",
        metadata: {
          storage_path: objectName,
          mime_type: mime,
          size_bytes: file.size,
          uploaded_by: user.id,
          uploaded_at: new Date().toISOString(),
        },
      });
      // Persist the upload columns the create helper doesn't expose
      // (the Insert type allows them but the repo's CreateCreativeInput
      // doesn't yet — patch after create rather than widen the
      // public input surface).
      creative = await updateCreative({
        workspaceId,
        creativeId: creative.id,
        patch: {
          storage_path: objectName,
          mime_type: mime,
          size_bytes: file.size,
          uploaded_by: user.id,
          uploaded_at: new Date().toISOString(),
        },
      });
    }

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.creative_uploaded",
      entityType: "weekly_plan_item_creative",
      entityId: creative.id,
      title: `Creative uploaded (${mime}, ${(file.size / 1024).toFixed(0)} KB)`,
    });
    revalidatePath("/weekly-plan");
    return actionOk({ creativeId: creative.id, assetUrl });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not upload creative.";
    console.error("[uploadCreativeAssetAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F2.8 — duplicatePlanItemAction
// =====================================================================
//
// Quick-action: clone a plan_item as a draft. Operator uses this to
// reuse a successful template (e.g. "post this on r/test then again
// next week"). Creative is NOT cloned — Signal forces the operator
// to attach a fresh creative so the same image isn't published twice
// (duplicate-permalink + fingerprint guards would refuse anyway, but
// cloning the creative would invite confusion).

export async function duplicatePlanItemAction(
  _prev: DuplicatePlanItemResult,
  formData: FormData,
): Promise<DuplicatePlanItemResult> {
  const sourceId = String(formData.get("item_id") ?? "").trim();
  if (!sourceId) return actionFail("Missing item id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const source = await getPlanItemById(workspaceId, sourceId);
    if (!source) return actionFail("Source item not found.");

    const cloned = await createPlanItem({
      workspaceId,
      weeklyPlanId: source.weeklyPlanId,
      title: source.title ? `${source.title} (copy)` : null,
      body: source.body,
      platform: source.platform,
      contentType: source.contentType,
      productId: source.productId,
      accountId: source.accountId,
      // Schedule and creative are deliberately NOT copied. The
      // operator reschedules and attaches a fresh creative.
      status: "draft",
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.duplicated",
      entityType: "weekly_plan_item",
      entityId: cloned.id,
      title: `Duplicated "${source.title ?? "Untitled"}"`,
      description: `Cloned as draft. Schedule + creative cleared.`,
    });

    revalidatePath("/weekly-plan");
    return actionOk({ itemId: cloned.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not duplicate plan item.";
    console.error("[duplicatePlanItemAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F2.9 — composeUpsertDraftAction
// =====================================================================
//
// Single action the compose sheet calls for both first-keystroke
// create and every subsequent autosave update. Keeps the operator
// experience identical regardless of whether a row exists yet.
//
// If form.item_id is empty: create a draft with smart defaults
// (status='draft', platform='reddit', content_type='post'). Returns
// the new id so the client can store it for subsequent updates.
//
// If form.item_id is set: update the existing row via the same
// patch surface as updatePlanItemAction. Status transitions are
// restricted to draft / pending_approval / skipped (same rule).

export async function composeUpsertDraftAction(
  _prev: ComposeUpsertDraftResult,
  formData: FormData,
): Promise<ComposeUpsertDraftResult> {
  const itemIdRaw = String(formData.get("item_id") ?? "").trim();
  const itemId = itemIdRaw.length > 0 ? itemIdRaw : null;
  const title = String(formData.get("title") ?? "");
  const body = String(formData.get("body") ?? "");
  const platform = String(formData.get("platform") ?? "").trim() || null;
  const contentType =
    String(formData.get("content_type") ?? "").trim() || null;
  const accountId =
    String(formData.get("account_id") ?? "").trim() || null;
  const productId =
    String(formData.get("product_id") ?? "").trim() || null;
  const subreddit =
    String(formData.get("subreddit") ?? "").trim() || null;
  const riskScoreRaw = String(formData.get("risk_score") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Don't auto-create a row from the first empty keystroke — but DO
  // accept an upsert with empty title if the row already exists (the
  // operator may be clearing the title intentionally).
  if (!itemId && title.trim().length === 0 && body.trim().length === 0) {
    return actionFail("Add a title or body before saving.");
  }

  // Schedule handling has been moved to a dedicated server action
  // (saveScheduleAction). This action MUST NOT touch scheduled_at —
  // body/title/platform/creative autosaves cannot drift the schedule.
  // If the field is present in FormData it's silently ignored.
  const scheduledAtIso: string | null | undefined = undefined;

  let riskScore: number | null | undefined = undefined;
  if (formData.has("risk_score")) {
    if (riskScoreRaw.length === 0) {
      riskScore = null;
    } else {
      const n = Number(riskScoreRaw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return actionFail("Risk score must be a number 0–100.");
      }
      riskScore = n;
    }
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    // --- UPDATE path ---
    if (itemId) {
      const patch: import("@/lib/supabase/types").WeeklyPlanItemUpdate = {};
      patch.title = title.trim().length === 0 ? null : title.trim();
      patch.body = body.length === 0 ? null : body;
      if (platform !== null) patch.platform = platform;
      if (contentType !== null) patch.content_type = contentType;
      if (formData.has("account_id")) patch.account_id = accountId;
      if (formData.has("product_id")) patch.product_id = productId;
      if (scheduledAtIso !== undefined) patch.scheduled_at = scheduledAtIso;
      if (riskScore !== undefined) patch.risk_score = riskScore;

      // Stash subreddit + notes into metadata.
      const existing = await getPlanItemById(workspaceId, itemId);
      const meta = { ...(existing.metadata as Record<string, unknown>) };
      if (formData.has("subreddit")) {
        if (subreddit) meta.target = subreddit;
        else delete meta.target;
      }
      if (formData.has("notes")) {
        if (notes) meta.operator_notes = notes;
        else delete meta.operator_notes;
      }
      patch.metadata = meta;

      const updated = await updatePlanItem({
        workspaceId,
        itemId,
        patch,
      });
      revalidatePath("/weekly-plan");
      return actionOk({ itemId: updated.id });
    }

    // --- CREATE path: ensure a weekly plan exists, then insert a
    //     draft with the compose-time smart defaults.
    let plan = await getCurrentWeeklyPlan(workspaceId);
    if (!plan) {
      plan = await createWeeklyPlan({
        workspaceId,
        title: "This week",
        weekStart: isoMonday(new Date()),
      });
      await logActivityBestEffort({
        workspaceId,
        eventType: "weekly_plan.created",
        entityType: "weekly_plan",
        entityId: plan.id,
        title: "Weekly plan created",
        description: `Week of ${plan.weekStart}.`,
      });
    }

    const item = await createPlanItem({
      workspaceId,
      weeklyPlanId: plan.id,
      title: title.trim().length === 0 ? null : title.trim(),
      body: body.length === 0 ? null : body,
      platform: platform ?? "reddit",
      contentType: contentType ?? "post",
      productId,
      accountId,
      scheduledAt: scheduledAtIso ?? null,
      riskScore: riskScore ?? null,
      status: "draft",
      metadata: {
        ...(subreddit ? { target: subreddit } : {}),
        ...(notes ? { operator_notes: notes } : {}),
        compose_origin: "founder_compose_sheet",
      },
    });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.created",
      entityType: "weekly_plan_item",
      entityId: item.id,
      title: `Draft "${item.title ?? "Untitled"}" started`,
      description: null,
    });

    revalidatePath("/weekly-plan");
    return actionOk({ itemId: item.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not save draft.";
    console.error("[composeUpsertDraftAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// saveScheduleAction — schedule-only write path
// =====================================================================
//
// The compose sheet calls this when the operator touches the schedule
// picker. It is INTENTIONALLY decoupled from composeUpsertDraftAction
// so the body/title autosave can never accidentally rewrite the
// scheduled timestamp.
//
// Required form fields:
//   item_id   — non-empty
//   reason    — "preset" | "input" | "clear" — written to activity
//               metadata. Missing or unrecognized → reject.
//   scheduled_at — must either be an empty string (clear) or a
//               fully-qualified ISO timestamp with timezone designator.
//               Bare datetime-local strings are rejected so the
//               server can't reinterpret them in UTC.
//
// Refuses items that are already published/rejected/backlog.

const SCHEDULE_SAVE_REASONS = new Set([
  "preset",
  "input",
  "clear",
  "mcp",
]);

const SCHEDULE_SOURCES = new Set<ScheduleSource>([
  "manual",
  "preset",
  "mcp",
  "api",
  "migration",
  "recovery",
]);

function reasonToSourceServer(reason: string): ScheduleSource {
  switch (reason) {
    case "preset":
      return "preset";
    case "mcp":
      return "mcp";
    case "input":
    case "clear":
      return "manual";
    default:
      return "manual";
  }
}

export async function saveScheduleAction(
  _prev: SaveScheduleResult,
  formData: FormData,
): Promise<SaveScheduleResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const reason = String(formData.get("reason") ?? "").trim();
  if (!SCHEDULE_SAVE_REASONS.has(reason)) {
    emitScheduleSaveRejected({
      itemId,
      source: null,
      reason: reason || null,
      detail: "missing or invalid reason",
    });
    return actionFail(
      "Schedule writes require an explicit reason (preset, input, clear, or mcp).",
    );
  }

  // Source — defaults from reason when the client doesn't override.
  const rawSource = String(formData.get("source") ?? "").trim() as ScheduleSource;
  const source: ScheduleSource = SCHEDULE_SOURCES.has(rawSource)
    ? rawSource
    : reasonToSourceServer(reason);

  const parsedSchedule = parseScheduledAtField(formData);
  if (parsedSchedule.kind === "error") {
    emitScheduleParseInvalid({
      itemId,
      source,
      reason,
      detail: parsedSchedule.message,
    });
    return actionFail(parsedSchedule.message);
  }
  if (parsedSchedule.kind === "skip") {
    return actionFail("Missing scheduled_at field.");
  }
  const nextIso = parsedSchedule.kind === "clear" ? null : parsedSchedule.iso;

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getPlanItemById(workspaceId, itemId);
    if (
      existing.status === "published" ||
      existing.status === "rejected" ||
      existing.status === "backlog"
    ) {
      return actionFail(
        "This post's schedule can't be changed in its current state.",
      );
    }

    const serverChecksum = scheduleChecksum({
      itemId,
      iso: nextIso,
      timezone: "UTC", // server always normalizes to UTC
      source,
    });

    if (existing.scheduledAt === nextIso) {
      // No-op write — don't bother revalidating.
      emitScheduleSaveSuccess({
        itemId,
        source,
        reason,
        checksum: serverChecksum,
        detail: "noop",
      });
      return actionOk({
        itemId,
        scheduledAtIso: nextIso,
        serverChecksum,
        source,
      });
    }

    // Persist the source into the row's metadata for audit trail.
    const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    const prevSource =
      typeof prevMeta.schedule_source === "string"
        ? (prevMeta.schedule_source as string)
        : null;
    const nextMeta: Record<string, unknown> = {
      ...prevMeta,
      schedule_source: source,
      schedule_source_at: new Date().toISOString(),
      schedule_checksum: serverChecksum,
    };

    const updated = await updatePlanItem({
      workspaceId,
      itemId,
      patch: { scheduled_at: nextIso, metadata: nextMeta },
    });

    if (prevSource && prevSource !== source) {
      emitScheduleSourceChange({
        itemId,
        source,
        reason,
        detail: `${prevSource} → ${source}`,
        checksum: serverChecksum,
      });
    }

    // Mirror the schedule onto the active execution_item (if any) so
    // the scheduler tick picks up the operator's new time. Skip on
    // clear — unschedule flows through removePlanItemAction.
    const { resyncActiveExecutionItemSchedule } = await import(
      "@/core/scheduling/resync-execution-item-schedule.server"
    );
    const resyncOutcome = await resyncActiveExecutionItemSchedule({
      workspaceId,
      planItemId: itemId,
      nextScheduledAtIso: nextIso,
      source: reason === "mcp" ? "mcp" : "ui",
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.schedule_changed",
      entityType: "weekly_plan_item",
      entityId: itemId,
      title: `Schedule ${nextIso === null ? "cleared" : "updated"}`,
      description: `Reason: ${reason} · Source: ${source} · Checksum: ${serverChecksum}.`,
      metadata: { execution_item_resync_mode: resyncOutcome.mode },
    });

    emitScheduleSaveSuccess({
      itemId,
      source,
      reason,
      checksum: serverChecksum,
    });

    // Operator-facing blocker (skip_paused/failed/running/terminal)
    // is surfaced as an actionFail so the UI can render the calm
    // recovery copy. The plan_item.scheduled_at write already
    // succeeded — we just tell the operator that the in-flight /
    // terminal execution_item won't follow.
    if (resyncOutcome.mode === "blocked" && resyncOutcome.message) {
      revalidatePath("/weekly-plan");
      return actionFail(resyncOutcome.message);
    }

    // Canonical display fields — populated for non-null schedules so
    // the UI can echo the time without re-deriving from the ISO.
    const { createSupabaseServerClient: makeClient } = await import(
      "@/lib/supabase"
    );
    const supabaseForTz = makeClient();
    const { data: wsSettingsForTz } = await supabaseForTz
      .from("workspace_settings")
      .select("timezone")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const workspaceTimezone =
      (wsSettingsForTz as { timezone?: string | null } | null)?.timezone ??
      "UTC";
    let scheduledAtLocal: string | null = null;
    let scheduledAtUtcDebug: string | null = null;
    let dueInSeconds: number | null = null;
    let dueLabel: string | null = null;
    let effectiveSource: "execution_item" | "weekly_plan_item" | "none" =
      "none";
    if (nextIso !== null) {
      const { formatScheduleDisplay } = await import(
        "@/core/scheduling/format-schedule-display"
      );
      const display = formatScheduleDisplay({
        planItem: { scheduledAt: nextIso },
        executionItem:
          resyncOutcome.mode === "rescheduled_active_execution_item"
            ? { status: "scheduled", scheduledAt: nextIso }
            : null,
        workspaceTimezone,
        serverNow: new Date(),
      });
      scheduledAtLocal = display.local;
      scheduledAtUtcDebug = display.utc;
      dueInSeconds = display.dueInSeconds;
      dueLabel = display.relative;
      effectiveSource = display.source;
    }

    revalidatePath("/weekly-plan");
    return actionOk({
      itemId: updated.id,
      scheduledAtIso: nextIso,
      serverChecksum,
      source,
      scheduledAtLocal,
      scheduledAtUtcDebug,
      timezone: workspaceTimezone,
      dueInSeconds,
      dueLabel,
      effectiveSource,
      executionItemId: resyncOutcome.executionItemId,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not save schedule.";
    console.error("[saveScheduleAction] failed", error);
    emitScheduleSaveRejected({
      itemId,
      source,
      reason,
      detail: message,
    });
    return actionFail(message);
  }
}

// =====================================================================
// Phase F2.9 — sendForApprovalAction
// =====================================================================
//
// One-click intent: move a draft to pending_approval. Refuses items
// that aren't in 'draft' or 'skipped' so the operator can't reroute
// already-scheduled/published items by mistake.

export async function sendForApprovalAction(
  _prev: SendForApprovalResult,
  formData: FormData,
): Promise<SendForApprovalResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getPlanItemById(workspaceId, itemId);
    if (
      existing.status !== "draft" &&
      existing.status !== "skipped"
    ) {
      return actionFail(
        `Already ${existing.status}. Can only send drafts (or skipped items) for approval.`,
      );
    }
    if (!existing.title || existing.title.trim().length === 0) {
      return actionFail("Add a title before sending for approval.");
    }

    await updatePlanItem({
      workspaceId,
      itemId,
      patch: { status: "pending_approval" },
    });
    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.sent_for_approval",
      entityType: "weekly_plan_item",
      entityId: itemId,
      title: `"${existing.title}" sent for approval`,
      description: null,
    });

    revalidatePath("/weekly-plan");
    return actionOk({ itemId });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not send for approval.";
    console.error("[sendForApprovalAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// F4.3 — Remove / cancel a plan item before it publishes.
//
// Behavior by current status:
//   draft / pending_approval / rejected / backlog / skipped / paused
//     → hard-delete the row. Creatives cascade. No execution_item
//       has been created yet, so nothing else to clean up.
//   approved / scheduled
//     → cancel any execution_items first (so the scheduler tick
//       won't pick them up), then hard-delete the plan item.
//   published / failed
//     → never destroy the row silently. We refuse and tell the
//       founder. publish_history is untouched regardless.
//
// publish_history rows are NEVER deleted by this action.
// =====================================================================
export type RemovePlanItemResult = ActionResult<{ itemId: string }>;

export async function removePlanItemAction(
  _prev: RemovePlanItemResult,
  formData: FormData,
): Promise<RemovePlanItemResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getPlanItemById(workspaceId, itemId);

    if (existing.status === "published") {
      return actionFail(
        "This post is already published. You can remove or delete it from the platform itself; Signal keeps the record so your history stays intact.",
      );
    }

    // For approved / scheduled posts, cancel the corresponding
    // execution_items first so the scheduler tick can't race us.
    const requiresExecutionCleanup =
      existing.status === "approved" || existing.status === "scheduled";
    let cancelledExecutionItems = 0;
    if (requiresExecutionCleanup) {
      const linked = await listExecutionItemsByPlanItemIds(workspaceId, [
        itemId,
      ]);
      for (const ei of linked) {
        if (
          ei.status === "completed" ||
          ei.status === "failed" ||
          ei.status === "cancelled"
        ) {
          continue;
        }
        try {
          await updateExecutionItemStatus({
            workspaceId,
            itemId: ei.id,
            to: "cancelled",
          });
          cancelledExecutionItems += 1;
        } catch (err) {
          // If the transition isn't legal (e.g. item is 'running'),
          // refuse to delete the plan item — we'd be racing the publish.
          console.error("[removePlanItemAction] cannot cancel ei", err);
          return actionFail(
            "Signal is currently publishing this post. Wait a few seconds and try again.",
          );
        }
      }
    }

    await deletePlanItem({ workspaceId, itemId });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.removed",
      entityType: "weekly_plan_item",
      entityId: itemId,
      title: `"${existing.title ?? "Untitled"}" removed from plan`,
      description:
        cancelledExecutionItems > 0
          ? `Cancelled ${cancelledExecutionItems} scheduled publish${
              cancelledExecutionItems === 1 ? "" : "es"
            }.`
          : null,
      metadata: { prior_status: existing.status, cancelledExecutionItems },
    });

    revalidatePath("/weekly-plan");
    revalidatePath("/dashboard");
    revalidatePath("/execution");
    return actionOk({ itemId });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not remove this post.";
    console.error("[removePlanItemAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Creative approval / rejection — first-class operator actions
// =====================================================================
//
// Background — the approval deadlock these actions resolve
// --------------------------------------------------------
// `assessItemApprovalReadiness` (server) refuses to approve a post
// whose attached creative is anything but `status='approved'`. This
// is correct: it preserves the operator-trust contract that a post
// can't ship without an explicit creative approval.
//
// The deadlock was UI/UX: there was NO server action that flipped
// `weekly_plan_item_creatives.status` from `pending_review` to
// `approved`. The only path was the catch-all `attachCreativeAction`
// with `approve_now=true`, which required the operator to reopen
// the compose modal and re-submit the creative form. Operators
// reasonably read the "Creative needs to be approved" copy as
// "the system will approve it automatically" — and bounced.
//
// These actions surface creative approval as first-class buttons.
// They DO NOT weaken the approval boundary:
//   - run on cookie session (operator), not MCP token
//   - re-validate the creative's readiness before flipping
//     (`creativeReadinessReason` must return null for approval)
//   - refuse to mutate creatives whose post is already `published`
//   - log activity for the audit trail
//   - never auto-approve from any side effect (MCP, scheduler)
//
// Removing a creative still unblocks post approval via the existing
// `removeCreativeAction`.

export async function approveCreativeAction(
  _prev: ApproveCreativeResult,
  formData: FormData,
): Promise<ApproveCreativeResult> {
  const creativeId = String(formData.get("creative_id") ?? "").trim();
  if (!creativeId) return actionFail("Missing creative id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getCreativeById(workspaceId, creativeId);

    // Lock once the post has actually published — the creative is
    // historical at that point.
    const planItem = await getPlanItemById(
      workspaceId,
      existing.weeklyPlanItemId,
    );
    if (planItem.status === "published") {
      return actionFail(
        "Cannot change creative status after the post has published.",
      );
    }
    if (existing.status === "approved") {
      // Idempotent — already in target state. Return ok so the UI
      // doesn't flash an error when the operator double-clicks.
      return actionOk({
        creativeId: existing.id,
        status: "approved" as const,
      });
    }

    // Re-validate readiness. This guard prevents approving a creative
    // that's still missing asset/alt/license/etc. — the operator's
    // approval is a commitment, not a YOLO.
    const { creativeReadinessReason } = await import(
      "@/repositories/weekly-plan-creative-repository"
    );
    // creativeReadinessReason returns "creative_not_approved" for
    // a creative that's otherwise ready but not yet approved — that's
    // the exact state we're trying to fix. Treat that single code as
    // "ready to be approved"; any other non-null code is a real
    // blocker.
    const reason = creativeReadinessReason({
      ...existing,
      status: "approved",
    } as never);
    if (reason !== null) {
      const { creativeBlockerCopy } = await import(
        "./approval-readiness.shared"
      );
      return actionFail(
        `Cannot approve this creative yet — ${creativeBlockerCopy(reason)}`,
      );
    }

    const updated = await updateCreative({
      workspaceId,
      creativeId: existing.id,
      patch: { status: "approved" },
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.creative_approved",
      entityType: "weekly_plan_item_creative",
      entityId: updated.id,
      title: `Creative approved (${updated.creativeType} · ${updated.sourceType})`,
      description: null,
      metadata: { plan_item_id: updated.weeklyPlanItemId },
    });

    revalidatePath("/weekly-plan");
    return actionOk({
      creativeId: updated.id,
      status: "approved" as const,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not approve creative.";
    console.error("[approveCreativeAction] failed", error);
    return actionFail(message);
  }
}

export async function rejectCreativeAction(
  _prev: RejectCreativeResult,
  formData: FormData,
): Promise<RejectCreativeResult> {
  const creativeId = String(formData.get("creative_id") ?? "").trim();
  if (!creativeId) return actionFail("Missing creative id.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getCreativeById(workspaceId, creativeId);

    const planItem = await getPlanItemById(
      workspaceId,
      existing.weeklyPlanItemId,
    );
    if (planItem.status === "published") {
      return actionFail(
        "Cannot change creative status after the post has published.",
      );
    }
    if (existing.status === "rejected") {
      return actionOk({
        creativeId: existing.id,
        status: "rejected" as const,
      });
    }

    const updated = await updateCreative({
      workspaceId,
      creativeId: existing.id,
      patch: { status: "rejected" },
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.creative_rejected",
      entityType: "weekly_plan_item_creative",
      entityId: updated.id,
      title: `Creative rejected (${updated.creativeType} · ${updated.sourceType})`,
      description: null,
      metadata: { plan_item_id: updated.weeklyPlanItemId },
    });

    revalidatePath("/weekly-plan");
    return actionOk({
      creativeId: updated.id,
      status: "rejected" as const,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not reject creative.";
    console.error("[rejectCreativeAction] failed", error);
    return actionFail(message);
  }
}
