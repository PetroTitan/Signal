import {
  getPermission,
  type ApprovalMode,
  type RiskLevel,
} from "./operation-permissions";
import type { McpOperationType } from "./operation-types";

/**
 * Outcome of the approval gate for a single operation attempt. The
 * runner consumes this directly.
 */
export type ApprovalDecision =
  | { allowed: true; reason: "no_approval_needed"; status: "running" }
  | {
      allowed: true;
      reason: "approval_provided";
      status: "approved";
      approvedBy: string;
    }
  | {
      allowed: false;
      reason: "approval_required";
      status: "pending_approval";
    }
  | {
      allowed: false;
      reason: "explicit_text_confirmation_required";
      status: "pending_approval";
      expectedPhrase: string;
    }
  | { allowed: false; reason: "blocked"; status: "blocked" };

export interface ApprovalInput {
  /** ID of the user who clicked Approve (or typed the phrase). */
  approvedBy?: string;
  /** Free-form phrase the user typed; required for
   *  `explicit_text_confirmation_required` ops. */
  confirmationPhrase?: string;
  /** Expected phrase to compare against (e.g. project name). */
  expectedPhrase?: string;
}

export function evaluateApproval(
  operationType: McpOperationType,
  input: ApprovalInput = {},
): ApprovalDecision {
  const permission = getPermission(operationType);
  const mode: ApprovalMode = permission.approvalMode;

  if (mode === "blocked") {
    return { allowed: false, reason: "blocked", status: "blocked" };
  }
  if (mode === "no_approval_needed") {
    return {
      allowed: true,
      reason: "no_approval_needed",
      status: "running",
    };
  }
  if (mode === "approval_required") {
    if (!input.approvedBy) {
      return {
        allowed: false,
        reason: "approval_required",
        status: "pending_approval",
      };
    }
    return {
      allowed: true,
      reason: "approval_provided",
      status: "approved",
      approvedBy: input.approvedBy,
    };
  }
  if (mode === "explicit_text_confirmation_required") {
    const expectedPhrase = input.expectedPhrase ?? "";
    if (
      !input.approvedBy ||
      !input.confirmationPhrase ||
      !expectedPhrase ||
      input.confirmationPhrase.trim() !== expectedPhrase.trim()
    ) {
      return {
        allowed: false,
        reason: "explicit_text_confirmation_required",
        status: "pending_approval",
        expectedPhrase,
      };
    }
    return {
      allowed: true,
      reason: "approval_provided",
      status: "approved",
      approvedBy: input.approvedBy,
    };
  }
  return { allowed: false, reason: "blocked", status: "blocked" };
}

export interface OperationGateContext {
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
}

export function describeGate(
  operationType: McpOperationType,
): OperationGateContext {
  const p = getPermission(operationType);
  return { riskLevel: p.riskLevel, approvalMode: p.approvalMode };
}
