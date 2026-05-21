import {
  ELIGIBLE_FOR_PLANNING,
  NOT_ELIGIBLE_FOR_PLANNING,
  type AccountStatus,
  type GrowthAccount,
} from "@/types";

export function planningEligibility(account: GrowthAccount): {
  eligible: boolean;
  status: AccountStatus;
  reason: string;
} {
  if (ELIGIBLE_FOR_PLANNING.includes(account.status)) {
    return {
      eligible: true,
      status: account.status,
      reason:
        account.status === "warming"
          ? "Warming. Keep tone observational; promotional items will be flagged."
          : "Eligible for weekly planning.",
    };
  }
  if (NOT_ELIGIBLE_FOR_PLANNING.includes(account.status)) {
    return {
      eligible: false,
      status: account.status,
      reason: ineligibleReason(account.status),
    };
  }
  return {
    eligible: false,
    status: account.status,
    reason: "Account state cannot participate in weekly planning right now.",
  };
}

function ineligibleReason(status: AccountStatus): string {
  switch (status) {
    case "planned":
      return "Account is only planned. Generate the kit and create the account on the platform first.";
    case "setup_needed":
      return "Setup is incomplete. Finish the checklist to make this account eligible.";
    case "awaiting_manual_creation":
      return "Account has not been created on the platform yet. Signal will not create it automatically.";
    case "paused":
      return "Account is paused. Resume it to participate in the weekly plan.";
    default:
      return "Account is not eligible.";
  }
}
