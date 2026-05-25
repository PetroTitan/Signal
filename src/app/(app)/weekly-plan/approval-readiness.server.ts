import "server-only";

/**
 * Server-side approval-readiness assessor.
 *
 * Imports the server-only creative repository to call
 * `creativeReadinessReason`. Used exclusively by server actions in
 * `_actions.ts`. UI code MUST import the pure helpers from
 * `approval-readiness.shared.ts` instead — there is an
 * import-integrity regression test that fails CI if a UI file
 * (`"use client"` or its component graph) ever imports this module.
 */

import {
  creativeReadinessReason,
  type WeeklyPlanItemCreative,
} from "@/repositories/weekly-plan-creative-repository";
import type { WeeklyContract } from "@/core/weekly-contract/approval-contract-types";
import type { WeeklyPlanItem } from "@/repositories/weekly-plan-repository";
import {
  creativeBlockerCopy,
  type ApprovalReadiness,
  type CreativeReadinessCode,
} from "./approval-readiness.shared";

export type { ApprovalReadiness } from "./approval-readiness.shared";
export { summarizeReadiness } from "./approval-readiness.shared";

export interface ApprovalReadinessInput {
  item: WeeklyPlanItem;
  /** Active workspace contract. Null when the operator has none —
   *  treated according to `requireContract`. */
  contract: WeeklyContract | null;
  /** Primary creative attached to the item (the first creative when
   *  multiple exist). Null when the item has no creative. */
  primaryCreative: WeeklyPlanItemCreative | null;
  /** Whether a schedule is required by the caller's path. Hold
   *  paths pass false; immediate-schedule paths pass true. */
  requireSchedule: boolean;
  /**
   * Statuses accepted by the caller's path. Defaults to
   * `["pending_approval"]` so existing callers are unaffected.
   *
   * `scheduleApprovedItemAction` (post-approval schedule) passes
   * `["approved"]` since the row is already past the approval gate.
   */
  allowedStatuses?: ReadonlyArray<string>;
  /**
   * Whether the caller's path needs an active weekly contract.
   *
   *   - Per-item HOLD path passes false. Holding doesn't insert into
   *     execution_items (which has `contract_id NOT NULL`) and
   *     doesn't enforce contract scope at this layer, so the
   *     contract is irrelevant.
   *   - Per-item IMMEDIATE-SCHEDULE path passes true. The
   *     execution_items row literally cannot be inserted without a
   *     contract_id.
   *   - Bulk plan-wide paths pass true (governance: bulk approval
   *     stays gated by an explicit weekly contract).
   *
   * When false, contract + scope checks are skipped entirely.
   */
  requireContract: boolean;
}

export function assessItemApprovalReadiness(
  input: ApprovalReadinessInput,
): ApprovalReadiness {
  const blockers: string[] = [];

  const allowedStatuses = input.allowedStatuses ?? ["pending_approval"];
  const statusPending = allowedStatuses.includes(input.item.status);
  if (!statusPending) {
    blockers.push(
      `Item is in status "${input.item.status}" — allowed: ${allowedStatuses.join(", ")}.`,
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
    blockers.push(
      creativeBlockerCopy(creativeReasonCode as CreativeReadinessCode | null),
    );
  }

  // Contract handling — gated by requireContract.
  //
  // When the caller's path does NOT need a contract (per-item hold),
  // we report contractActive=true (so the ok-flag tells the UI the
  // path is unblocked) and skip the scope checks entirely.
  //
  // When the path DOES need one, we surface the blocker and run
  // scope checks against it.
  let contractActive = true;
  let accountScope = true;
  let productScope = true;
  let platformScope = true;
  if (input.requireContract) {
    contractActive = input.contract !== null;
    if (!contractActive) {
      blockers.push(
        "Scheduling requires an active weekly contract. You can approve & hold now, then activate a contract before scheduling.",
      );
    }
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
