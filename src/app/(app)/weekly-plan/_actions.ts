"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  deletePlanItem,
  getCurrentWeeklyPlan,
  getPlanItemById,
  updatePlanItem,
} from "@/repositories/weekly-plan-repository";
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
export type SaveScheduleResult = ActionResult<{
  itemId: string;
  scheduledAtIso: string | null;
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
      const primaryCreative = itemCreatives[0] ?? null;
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
      const primaryCreative = itemCreatives[0] ?? null;
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

    let itemsApproved = 0;
    for (const it of validItems) {
      // The single critical move: pending_approval → approved.
      // No execution_queue, no execution_item, no scheduled_at.
      await updatePlanItemStatus({
        workspaceId,
        itemId: it.id,
        status: "approved",
      });
      itemsApproved += 1;
    }

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
    revalidatePath("/approval-queue");
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
    revalidatePath("/approval-queue");
    revalidatePath("/activity");
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
      revalidatePath("/approval-queue");
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
    revalidatePath("/approval-queue");
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
    revalidatePath("/approval-queue");
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

export async function saveScheduleAction(
  _prev: SaveScheduleResult,
  formData: FormData,
): Promise<SaveScheduleResult> {
  const itemId = String(formData.get("item_id") ?? "").trim();
  if (!itemId) return actionFail("Missing item id.");

  const reason = String(formData.get("reason") ?? "").trim();
  if (!SCHEDULE_SAVE_REASONS.has(reason)) {
    return actionFail(
      "Schedule writes require an explicit reason (preset, input, clear, or mcp).",
    );
  }

  const parsedSchedule = parseScheduledAtField(formData);
  if (parsedSchedule.kind === "error") {
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

    if (existing.scheduledAt === nextIso) {
      // No-op write — don't bother revalidating.
      return actionOk({ itemId, scheduledAtIso: nextIso });
    }

    const updated = await updatePlanItem({
      workspaceId,
      itemId,
      patch: { scheduled_at: nextIso },
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "weekly_plan_item.schedule_changed",
      entityType: "weekly_plan_item",
      entityId: itemId,
      title: `Schedule ${nextIso === null ? "cleared" : "updated"}`,
      description: `Reason: ${reason}.`,
    });

    revalidatePath("/weekly-plan");
    return actionOk({ itemId: updated.id, scheduledAtIso: nextIso });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not save schedule.";
    console.error("[saveScheduleAction] failed", error);
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
    revalidatePath("/approval-queue");
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
