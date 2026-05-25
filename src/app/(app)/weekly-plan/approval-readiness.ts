/**
 * Pure approval-readiness assessor.
 *
 * Single source of truth for the rules that gate a plan_item from
 * pending_approval → approved. Used by:
 *
 *   - approveWeeklyPlanAction (bulk + immediate schedule)
 *   - approveAndHoldAction (bulk hold)
 *   - approvePlanItemAndHoldAction (per-item hold)
 *   - approvePlanItemAndScheduleAction (per-item immediate schedule)
 *   - PlanItemCard UI (to render exact blockers + enable/disable
 *     the per-item buttons)
 *
 * Pure. No I/O. No DB. No network. The repository layer reads the
 * row + contract + creative; this module judges them.
 */

import {
  creativeReadinessReason,
  type WeeklyPlanItemCreative,
} from "@/repositories/weekly-plan-creative-repository";
import type { WeeklyContract } from "@/core/weekly-contract/approval-contract-types";
import type { WeeklyPlanItem } from "@/repositories/weekly-plan-repository";

export interface ApprovalReadinessInput {
  item: WeeklyPlanItem;
  /** Active workspace contract. Null when the operator has none —
   *  the helper surfaces this as a blocker rather than throwing. */
  contract: WeeklyContract | null;
  /** Primary creative attached to the item (the first creative when
   *  multiple exist). Null when the item has no creative. */
  primaryCreative: WeeklyPlanItemCreative | null;
  /** Whether a schedule is required by the caller's path. Hold
   *  paths pass false; immediate-schedule paths pass true. */
  requireSchedule: boolean;
}

export interface ApprovalReadiness {
  /** True when all required blockers are clear for the path. */
  ready: boolean;
  /** Concrete blockers in operator-readable copy. Order is stable
   *  across calls so the UI can render them deterministically. */
  blockers: ReadonlyArray<string>;
  /**
   * Breakdown — UI can render structured affordances (focus the alt
   * text field, link the contract, etc.). Each flag is true when the
   * named condition is OK.
   */
  ok: {
    statusPending: boolean;
    riskNotBlocked: boolean;
    contentTypePost: boolean;
    creativeReady: boolean;
    contractActive: boolean;
    accountScope: boolean;
    productScope: boolean;
    platformScope: boolean;
    scheduleSet: boolean;
  };
}

export function assessItemApprovalReadiness(
  input: ApprovalReadinessInput,
): ApprovalReadiness {
  const blockers: string[] = [];

  const statusPending = input.item.status === "pending_approval";
  if (!statusPending) {
    blockers.push(
      `Item is in status "${input.item.status}" — only pending_approval items can be approved.`,
    );
  }

  const riskNotBlocked = input.item.riskLevel !== "blocked";
  if (!riskNotBlocked) {
    blockers.push("QA blocked this draft — risk level is 'blocked'.");
  }

  const contentTypePost = input.item.contentType === "post";
  if (!contentTypePost) {
    blockers.push(
      `Content type is "${input.item.contentType ?? "unset"}" — only posts can be approved.`,
    );
  }

  const creativeReasonCode = creativeReadinessReason(input.primaryCreative);
  const creativeReady = creativeReasonCode === null;
  if (!creativeReady) {
    blockers.push(creativeBlockerCopy(creativeReasonCode));
  }

  const contractActive = input.contract !== null;
  if (!contractActive) {
    blockers.push(
      "Active weekly contract required. Open /weekly-contracts to activate one.",
    );
  }

  // Scope checks only when a contract exists.
  let accountScope = true;
  let productScope = true;
  let platformScope = true;
  if (input.contract) {
    if (
      input.item.accountId &&
      !input.contract.scope.accountIds.includes(input.item.accountId)
    ) {
      accountScope = false;
      blockers.push("Account is out of the active contract's scope.");
    }
    if (
      input.item.productId &&
      !input.contract.scope.productIds.includes(input.item.productId)
    ) {
      productScope = false;
      blockers.push("Product is out of the active contract's scope.");
    }
    if (
      input.item.platform &&
      !input.contract.scope.platforms.includes(input.item.platform)
    ) {
      platformScope = false;
      blockers.push("Platform is out of the active contract's scope.");
    }
  }

  const scheduleSet = input.item.scheduledAt !== null;
  if (input.requireSchedule && !scheduleSet) {
    blockers.push(
      "Schedule is required before approving with immediate scheduling. Use Approve & hold to defer.",
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    ok: {
      statusPending,
      riskNotBlocked,
      contentTypePost,
      creativeReady,
      contractActive,
      accountScope,
      productScope,
      platformScope,
      scheduleSet,
    },
  };
}

function creativeBlockerCopy(
  code: ReturnType<typeof creativeReadinessReason>,
): string {
  switch (code) {
    case "creative_missing":
      return "Creative is missing. Upload an asset or generate one.";
    case "creative_missing_asset":
      return "Creative has no asset URL. Re-upload or attach a URL.";
    case "creative_missing_alt_text":
      return "Alt text is required before approval and publishing.";
    case "creative_not_approved":
      return "Creative needs to be approved before the post can be approved.";
    case "creative_rejected":
      return "Creative was rejected. Replace it before approval.";
    case "creative_only_planned":
      return "Creative is only planned — attach the actual asset.";
    case "creative_missing_license_or_attribution":
      return "Creative needs license + attribution for this source type.";
    case "creative_missing_prompt":
      return "Generated creative needs a prompt recorded.";
    default:
      return "Creative is not ready.";
  }
}

/**
 * Operator-facing one-liner summarizing what the post is awaiting.
 *
 * "Ready for post approval." when ready.
 * Otherwise: the first blocker, with "(+N more)" when there are
 * additional ones.
 */
export function summarizeReadiness(readiness: ApprovalReadiness): string {
  if (readiness.ready) return "Ready for post approval.";
  const first = readiness.blockers[0] ?? "Not ready for approval.";
  const extra =
    readiness.blockers.length > 1
      ? ` (+${readiness.blockers.length - 1} more)`
      : "";
  return `${first}${extra}`;
}

/**
 * Narrow surface needed by the UI helper below. Both
 * `WeeklyPlanItemCreative` and `CreativeCardData` satisfy it.
 */
export interface CreativeStateFields {
  status: string;
  sourceType: string;
  assetUrl: string | null;
  sourceUrl: string | null;
  altText: string | null;
}

/**
 * UI helper — short human label for the "Creative status" sub-row of
 * the card. Independent of post status so the operator can see at a
 * glance which side still needs work.
 */
export function describeCreativeState(
  creative: CreativeStateFields | null,
): { label: string; tone: "ok" | "needs_review" | "missing" | "blocked" } {
  if (!creative) return { label: "No creative", tone: "missing" };
  if (creative.status === "rejected")
    return { label: "Creative rejected", tone: "blocked" };
  if (
    !creative.assetUrl &&
    !creative.sourceUrl &&
    creative.sourceType !== "planned"
  ) {
    return { label: "Creative missing asset", tone: "missing" };
  }
  if (creative.sourceType === "planned") {
    return { label: "Creative planned (no asset yet)", tone: "missing" };
  }
  if (!creative.altText || creative.altText.trim().length === 0) {
    return { label: "Alt text missing", tone: "needs_review" };
  }
  if (creative.status === "approved") {
    return { label: "Creative approved", tone: "ok" };
  }
  return { label: "Creative pending review", tone: "needs_review" };
}
