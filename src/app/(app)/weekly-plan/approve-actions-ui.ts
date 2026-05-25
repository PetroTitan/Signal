/**
 * Pure UI-state helper for per-item approve actions.
 *
 * Given (scheduleSet, hasActiveContract, otherBlocker), decide what
 * to render for the "Approve post" slot and what to render for the
 * "Approve & hold" slot. Surfaces the operator-facing hint copy.
 *
 * Pure — no React, no I/O. Both the plan-item card and the modal
 * footer drive their UI off this so they cannot disagree about
 * which actions are enabled.
 *
 * Hold path is always available when there are no other blockers,
 * because the server-side `approvePlanItemAndHoldAction` is
 * contract-free. Schedule path needs BOTH a schedule AND a contract
 * (execution_items.contract_id is NOT NULL).
 */

export type ApproveActionsInput = {
  /** True when item has a scheduled_at set. */
  scheduleSet: boolean;
  /** True when the workspace has an active weekly contract. */
  hasActiveContract: boolean;
  /** Any other readiness blocker (alt text missing, creative not
   *  ready, etc.). When non-null, BOTH buttons are disabled. */
  otherBlocker?: string | null;
};

export type SchedulePostCta =
  | { kind: "enabled" }
  | { kind: "disabled_no_schedule"; hint: string }
  | { kind: "disabled_no_contract"; hint: string }
  | { kind: "disabled_other"; hint: string };

export type ApproveAndHoldCta =
  | { kind: "enabled" }
  | { kind: "disabled_other"; hint: string };

export interface ApproveActionsState {
  schedulePost: SchedulePostCta;
  approveAndHold: ApproveAndHoldCta;
  /**
   * Optional contextual helper shown alongside the buttons. Stable
   * one-liner that explains the overall posture (e.g., "Scheduling
   * requires an active weekly contract. You can approve & hold now,
   * then activate a contract before scheduling.").
   *
   * Distinct from the per-button hints above — this is the "why"
   * for the operator.
   */
  contextHint: string | null;
}

const NO_SCHEDULE_HINT = "Add a schedule time before approving for publish.";
const NO_CONTRACT_HINT =
  "Scheduling requires an active weekly contract. You can approve & hold now, then activate a contract before scheduling.";

export function deriveApproveActionsState(
  input: ApproveActionsInput,
): ApproveActionsState {
  if (input.otherBlocker) {
    return {
      schedulePost: { kind: "disabled_other", hint: input.otherBlocker },
      approveAndHold: { kind: "disabled_other", hint: input.otherBlocker },
      contextHint: null,
    };
  }
  if (!input.hasActiveContract) {
    return {
      schedulePost: {
        kind: "disabled_no_contract",
        hint: NO_CONTRACT_HINT,
      },
      approveAndHold: { kind: "enabled" },
      contextHint: NO_CONTRACT_HINT,
    };
  }
  if (!input.scheduleSet) {
    return {
      schedulePost: {
        kind: "disabled_no_schedule",
        hint: NO_SCHEDULE_HINT,
      },
      approveAndHold: { kind: "enabled" },
      contextHint: NO_SCHEDULE_HINT,
    };
  }
  return {
    schedulePost: { kind: "enabled" },
    approveAndHold: { kind: "enabled" },
    contextHint: null,
  };
}
