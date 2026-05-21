import type {
  ApprovalAction,
  BacklogItem,
  WeeklyPlan,
  WeeklyPlanItem,
  WeeklyPlanItemStatus,
} from "@/types";

export type ApprovalDecision =
  | "approve"
  | "reject"
  | "edit"
  | "rewrite_softer"
  | "remove_link"
  | "delay"
  | "convert_to_comment"
  | "save_to_backlog"
  | "pause"
  | "resume";

const HOUR_MS = 60 * 60 * 1000;

export function nextStatus(
  current: WeeklyPlanItemStatus,
  decision: ApprovalDecision,
): WeeklyPlanItemStatus {
  switch (decision) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "save_to_backlog":
      return "backlog";
    case "pause":
      return "paused";
    case "resume":
      return current === "paused" ? "pending_approval" : current;
    case "delay":
      return current === "approved" ? "approved" : current;
    case "edit":
    case "rewrite_softer":
    case "remove_link":
    case "convert_to_comment":
      return current;
    default:
      return current;
  }
}

export function applyDelay(item: WeeklyPlanItem, hours = 24): WeeklyPlanItem {
  const next = new Date(item.scheduledFor).getTime() + hours * HOUR_MS;
  return { ...item, scheduledFor: new Date(next).toISOString() };
}

export function removeLink(item: WeeklyPlanItem): WeeklyPlanItem {
  return {
    ...item,
    draft: { ...item.draft, cta: null, trackingLinkId: null },
  };
}

export function rewriteSofter(item: WeeklyPlanItem): WeeklyPlanItem {
  const softer = softenBody(item.draft.body);
  return { ...item, draft: { ...item.draft, body: softer } };
}

function softenBody(body: string): string {
  return body
    .replace(/\bbest\b/gi, "a useful")
    .replace(/\bmade me cry\b/gi, "was frustrating to use")
    .replace(/\bguaranteed\b/gi, "designed for")
    .replace(/\b100%\b/gi, "in our experience");
}

export function convertToComment(item: WeeklyPlanItem): WeeklyPlanItem {
  return {
    ...item,
    contentType: "comment_reply",
    draft: {
      ...item.draft,
      cta: null,
      trackingLinkId: null,
    },
  };
}

export function toBacklog(
  item: WeeklyPlanItem,
  reason: string,
  now = new Date(),
  workspaceId = "ws_helperg",
): BacklogItem {
  return {
    id: `bk_${item.id}_${now.getTime().toString(36)}`,
    workspaceId,
    accountId: item.accountId,
    productId: item.productId,
    platform: item.platform,
    contentType: item.contentType,
    draft: item.draft,
    risk: item.risk,
    movedFromPlanItemId: item.id,
    reason,
    movedAt: now.toISOString(),
  };
}

export function fromBacklog(
  bk: BacklogItem,
  planId: string,
  scheduledFor: string,
): WeeklyPlanItem {
  return {
    id: `item_${bk.id}_resched_${Date.now().toString(36)}`,
    planId,
    accountId: bk.accountId,
    productId: bk.productId,
    platform: bk.platform,
    contentType: bk.contentType,
    draft: bk.draft,
    scheduledFor,
    status: "pending_approval",
    risk: bk.risk,
  };
}

export function duplicateIntoNextWeek(
  item: WeeklyPlanItem,
  nextPlanId: string,
  weeksAhead = 1,
): WeeklyPlanItem {
  const future =
    new Date(item.scheduledFor).getTime() +
    weeksAhead * 7 * 24 * HOUR_MS;
  return {
    ...item,
    id: `${item.id}_dup_${Date.now().toString(36)}`,
    planId: nextPlanId,
    status: "draft",
    scheduledFor: new Date(future).toISOString(),
  };
}

export function summarizePlan(items: WeeklyPlanItem[]): PlanSummary {
  const total = items.length;
  const byStatus = countBy(items, (i) => i.status);
  const byRisk = countBy(items, (i) => i.risk.level);
  const byPlatform = countBy(items, (i) => i.platform);
  const byAccount = countBy(items, (i) => i.accountId);
  const byProduct = countBy(items, (i) => i.productId);
  return {
    total,
    byStatus,
    byRisk,
    byPlatform,
    byAccount,
    byProduct,
  };
}

function countBy<T, K extends string>(items: T[], key: (it: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface PlanSummary {
  total: number;
  byStatus: Partial<Record<WeeklyPlanItemStatus, number>>;
  byRisk: Partial<Record<WeeklyPlanItem["risk"]["level"], number>>;
  byPlatform: Partial<Record<WeeklyPlanItem["platform"], number>>;
  byAccount: Record<string, number>;
  byProduct: Record<string, number>;
}

export function planMeta(
  plan: WeeklyPlan,
  items: WeeklyPlanItem[],
): WeeklyPlan {
  return {
    ...plan,
    status: derivePlanStatus(plan, items),
  };
}

function derivePlanStatus(
  plan: WeeklyPlan,
  items: WeeklyPlanItem[],
): WeeklyPlan["status"] {
  if (items.length === 0) return "drafting";
  const pending = items.filter((i) => i.status === "pending_approval").length;
  const approved = items.filter(
    (i) => i.status === "approved" || i.status === "scheduled",
  ).length;
  const published = items.filter((i) => i.status === "published").length;

  if (published > 0 && approved === 0 && pending === 0) return "complete";
  if (published > 0) return "in_progress";
  if (pending === 0 && approved > 0) return "approved";
  if (pending > 0) return "awaiting_approval";
  return plan.status;
}

export const APPROVAL_ACTIONS: Record<ApprovalAction, string> = {
  approve: "Approve",
  reject: "Reject",
  edit: "Edit",
  rewrite_softer: "Rewrite softer",
  remove_link: "Remove link",
  delay: "Delay 24h",
  convert_to_comment: "Convert to comment",
  save_to_backlog: "Save to backlog",
};
