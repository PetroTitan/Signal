/**
 * Persistence-facing shape: what the runner records in the
 * execution_authorizations table after evaluation.
 *
 * The evaluator (contract-evaluator.ts) is pure — it doesn't know
 * about workspace IDs or scheduled item IDs. The repository combines
 * the evaluation result with the candidate's identifiers to build the
 * audit row.
 */

import type { AuthorizationResult } from "./authorization-result";
import type { WeeklyContractActionType } from "./approval-contract-types";

export interface ExecutionAuthorizationContext {
  workspaceId: string;
  contractId: string | null;
  actionType: WeeklyContractActionType;
  accountId: string | null;
  productId: string | null;
  platform: string | null;
  scheduledItemId: string | null;
  weeklyPlanItemId: string | null;
  /** Free-form metadata the caller wants persisted. */
  extraMetadata?: Record<string, unknown>;
}

export interface ExecutionAuthorizationRecord {
  workspaceId: string;
  contractId: string | null;
  actionType: string;
  accountId: string | null;
  productId: string | null;
  platform: string | null;
  scheduledItemId: string | null;
  weeklyPlanItemId: string | null;
  result: AuthorizationResult;
  metadata: Record<string, unknown>;
}

export function composeAuthorizationRecord(
  ctx: ExecutionAuthorizationContext,
  result: AuthorizationResult,
): ExecutionAuthorizationRecord {
  return {
    workspaceId: ctx.workspaceId,
    contractId: ctx.contractId,
    actionType: ctx.actionType,
    accountId: ctx.accountId,
    productId: ctx.productId,
    platform: ctx.platform,
    scheduledItemId: ctx.scheduledItemId,
    weeklyPlanItemId: ctx.weeklyPlanItemId,
    result,
    metadata: ctx.extraMetadata ?? {},
  };
}
