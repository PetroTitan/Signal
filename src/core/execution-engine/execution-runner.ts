/**
 * Pure execution-runner orchestrator.
 *
 * Takes an item, a contract, a cadence snapshot, and an
 * authorization-evaluator function, and returns the *intended* result:
 *
 *   - the AuthorizationResult to persist
 *   - the next item status
 *   - the composed log entries to append
 *   - the dry-run outcome
 *
 * The repository layer is the one that writes; the runner just
 * decides. Keeping this side-effect-free makes it trivial to test.
 */

import type {
  AuthorizationResult,
  EvaluateExecutionAuthorizationInput,
  WeeklyContract,
} from "@/core/weekly-contract";
import {
  evaluateExecutionAuthorization,
  type WeeklyContractActionType,
} from "@/core/weekly-contract";
import {
  composeAuthorizationLog,
  composeDryRunLog,
  composeItemLog,
  type ComposedLog,
} from "./execution-log-composer";
import { dryRunExecute, type DryRunOutcome } from "./dry-run-executor";
import type { ExecutionItem, ExecutionItemStatus } from "./execution-types";

export interface RunDryItemInput {
  item: ExecutionItem;
  contract: WeeklyContract | null;
  cadenceSnapshot: EvaluateExecutionAuthorizationInput["cadenceSnapshot"];
  localMoment: EvaluateExecutionAuthorizationInput["localMoment"];
  localDayKey: string;
  isDemoWorkspace: boolean;
}

export interface RunDryItemPlan {
  authorization: AuthorizationResult;
  dryRun: DryRunOutcome;
  nextStatus: ExecutionItemStatus;
  logs: ComposedLog[];
}

/**
 * Produces a fully-typed plan that the repository layer can apply
 * inside a transactional shell. No DB calls happen here.
 */
export function planDryRunForItem(input: RunDryItemInput): RunDryItemPlan {
  const authorization = evaluateExecutionAuthorization({
    contract: input.contract,
    actionType: input.item.actionType as WeeklyContractActionType,
    accountId: input.item.accountId,
    productId: input.item.productId,
    platform: input.item.platform,
    riskLevel: input.item.riskLevel ?? "medium",
    cadenceSnapshot: input.cadenceSnapshot,
    localMoment: input.localMoment,
    localDayKey: input.localDayKey,
    isDemoWorkspace: input.isDemoWorkspace,
  });

  const dryRun = dryRunExecute({
    workspaceId: input.item.workspaceId,
    itemId: input.item.id,
    actionType: input.item.actionType,
    platform: input.item.platform,
    authorization,
  });

  const nextStatus = pickNextStatus(input.item.status, dryRun);

  const logs: ComposedLog[] = [];
  logs.push(
    composeItemLog({
      workspaceId: input.item.workspaceId,
      queueId: input.item.queueId,
      executionItemId: input.item.id,
      eventType: "item.authorization_requested",
      message: "Evaluating authorization against the active contract.",
    }),
  );
  logs.push(
    composeAuthorizationLog({
      workspaceId: input.item.workspaceId,
      queueId: input.item.queueId,
      executionItemId: input.item.id,
      result: authorization,
    }),
  );
  logs.push(
    composeItemLog({
      workspaceId: input.item.workspaceId,
      queueId: input.item.queueId,
      executionItemId: input.item.id,
      eventType: "item.dry_run_started",
      message: "Dry-run started — no external platform calls will be made.",
    }),
  );
  logs.push(
    composeDryRunLog({
      workspaceId: input.item.workspaceId,
      queueId: input.item.queueId,
      executionItemId: input.item.id,
      dryRunAction: dryRun.dryRunAction ?? "blocked",
      message: dryRun.message,
    }),
  );

  if (dryRun.kind === "executed") {
    logs.push(
      composeItemLog({
        workspaceId: input.item.workspaceId,
        queueId: input.item.queueId,
        executionItemId: input.item.id,
        eventType: "item.completed",
        message: "Dry-run completed successfully.",
      }),
    );
  } else if (dryRun.kind === "backlogged") {
    logs.push(
      composeItemLog({
        workspaceId: input.item.workspaceId,
        queueId: input.item.queueId,
        executionItemId: input.item.id,
        eventType: "item.backlogged",
        message: dryRun.message,
        severity: "warning",
      }),
    );
  } else if (dryRun.kind === "skipped") {
    logs.push(
      composeItemLog({
        workspaceId: input.item.workspaceId,
        queueId: input.item.queueId,
        executionItemId: input.item.id,
        eventType: "item.skipped",
        message: dryRun.message,
        severity: "warning",
      }),
    );
  } else {
    logs.push(
      composeItemLog({
        workspaceId: input.item.workspaceId,
        queueId: input.item.queueId,
        executionItemId: input.item.id,
        eventType: "item.blocked",
        message: dryRun.message,
        severity: "error",
      }),
    );
  }

  return { authorization, dryRun, nextStatus, logs };
}

function pickNextStatus(
  current: ExecutionItemStatus,
  outcome: DryRunOutcome,
): ExecutionItemStatus {
  switch (outcome.kind) {
    case "executed":
      return "completed";
    case "backlogged":
      return "backlogged";
    case "skipped":
      return "skipped";
    case "blocked":
      return "blocked";
    default: {
      const _exhaustive: never = outcome;
      return current;
    }
  }
}
