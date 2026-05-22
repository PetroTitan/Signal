/**
 * The execution-authorization engine.
 *
 *   evaluateExecutionAuthorization(input) → AuthorizationResult
 *
 * Pure, synchronous. No DB calls. The repository layer is responsible
 * for loading the contract envelope, the cadence snapshot, and the
 * scheduled item, then calling this function with the resolved inputs.
 *
 * Evaluation order (the first failure wins):
 *   1. Demo mode hard_block.
 *   2. No active contract.
 *   3. Contract paused / expired.
 *   4. Action type allowed?
 *   5. Account / product / platform in scope?
 *   6. Risk under ceiling?
 *   7. Cadence ceilings (total, per-day, per-platform per-day).
 *   8. Execution window check.
 *
 * Any rule that fails returns immediately with the matching reason
 * code. Allowed results are uniform: the canonical ALLOWED_RESULT.
 */

import type { RiskLevel } from "@/lib/supabase/types";
import {
  ALLOWED_RESULT,
  deny,
  type AuthorizationResult,
} from "./authorization-result";
import type {
  WeeklyContract,
  WeeklyContractActionType,
} from "./approval-contract-types";
import { isAuthorizingStatus } from "./contract-status";
import { fitsUnderRiskCeiling } from "./contract-risk";
import {
  evaluateCadence,
  type ActionCountSnapshot,
} from "./cadence-policy";
import {
  isWithinAnyWindow,
  type LocalMoment,
} from "./execution-window";

export interface EvaluateExecutionAuthorizationInput {
  /** The candidate contract, or null if none. */
  contract: WeeklyContract | null;
  actionType: WeeklyContractActionType;
  accountId: string | null;
  productId: string | null;
  platform: string | null;
  /** The item's risk level (from risk_events / item risk score). */
  riskLevel: RiskLevel;
  /** Cadence usage at the time of evaluation. */
  cadenceSnapshot: ActionCountSnapshot;
  /** Local moment of the candidate action. */
  localMoment: LocalMoment;
  /** Local day key ("YYYY-MM-DD"). */
  localDayKey: string;
  /** True when the caller is operating against a demo workspace. */
  isDemoWorkspace: boolean;
}

export function evaluateExecutionAuthorization(
  input: EvaluateExecutionAuthorizationInput,
): AuthorizationResult {
  if (input.isDemoWorkspace) {
    return deny("demo_mode_blocked", {
      severity: "hard_block",
      reasonDetail: "Demo workspaces never authorize execution.",
      suggestedAction: "request_new_approval",
    });
  }

  const contract = input.contract;

  if (!contract) {
    return deny("no_active_contract", {
      severity: "hard_block",
      reasonDetail: "There is no active weekly contract for this workspace.",
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (contract.status === "paused") {
    return deny("contract_paused", {
      severity: "soft_block",
      reasonDetail: "The active contract is paused.",
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (contract.status === "expired" || !isAuthorizingStatus(contract.status)) {
    return deny("contract_expired", {
      severity: "hard_block",
      reasonDetail: `Contract is in status "${contract.status}".`,
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (!contract.scope.allowedActions.includes(input.actionType)) {
    return deny("action_not_permitted", {
      severity: "hard_block",
      reasonDetail: `Action "${input.actionType}" is not in this contract's allowed list.`,
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (input.accountId && !contract.scope.accountIds.includes(input.accountId)) {
    return deny("account_out_of_scope", {
      severity: "hard_block",
      reasonDetail: "This account is not in the contract scope.",
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (input.productId && !contract.scope.productIds.includes(input.productId)) {
    return deny("product_out_of_scope", {
      severity: "hard_block",
      reasonDetail: "This product is not in the contract scope.",
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (input.platform && !contract.scope.platforms.includes(input.platform)) {
    return deny("platform_out_of_scope", {
      severity: "hard_block",
      reasonDetail: "This platform is not in the contract scope.",
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  if (!fitsUnderRiskCeiling(input.riskLevel, contract.maxRiskLevel)) {
    return deny("risk_above_ceiling", {
      severity: "hard_block",
      reasonDetail: `Item risk "${input.riskLevel}" exceeds ceiling "${contract.maxRiskLevel}".`,
      suggestedAction: "request_new_approval",
      shouldBacklog: true,
    });
  }

  const cadence = evaluateCadence({
    contract,
    snapshot: input.cadenceSnapshot,
    evaluatedOnLocalDay: input.localDayKey,
    platform: input.platform,
  });

  if (cadence.kind === "total_exceeded") {
    return deny("cadence_total_exceeded", {
      severity: "soft_block",
      reasonDetail: `Weekly cap of ${contract.maxActionsTotal} reached.`,
      suggestedAction: "reschedule",
      shouldBacklog: true,
    });
  }
  if (cadence.kind === "per_day_exceeded") {
    return deny("cadence_per_day_exceeded", {
      severity: "soft_block",
      reasonDetail: `Daily cap of ${contract.maxActionsPerDay} reached.`,
      suggestedAction: "reschedule",
      shouldBacklog: true,
    });
  }
  if (cadence.kind === "per_platform_exceeded") {
    return deny("cadence_per_platform_exceeded", {
      severity: "soft_block",
      reasonDetail: `Per-platform daily cap of ${contract.maxActionsPerPlatformPerDay} reached on ${input.platform}.`,
      suggestedAction: "reschedule",
      shouldBacklog: true,
    });
  }

  if (!isWithinAnyWindow(input.localMoment, contract.scope.executionWindows)) {
    return deny("outside_execution_window", {
      severity: "soft_block",
      reasonDetail: "Outside the contract's execution windows.",
      suggestedAction: "reschedule",
      shouldBacklog: false,
    });
  }

  return ALLOWED_RESULT;
}
