/**
 * Phase E1 — Weekly Operating Contract canonical types.
 *
 * Single source of truth for the action types, status lifecycle, risk
 * ceiling, and outcome / reason vocabulary used by the contract engine.
 * Mirrors the CHECK constraints in
 *   supabase/migrations/20260522040001_phase_e1_weekly_contract_schema.sql
 *
 * Any change to either side must be made to both at the same time. The
 * engine reads from this file and writes through the repository layer.
 */

import type {
  ExecutionAuthorizationOutcome,
  ExecutionAuthorizationReasonCode,
  ExecutionAuthorizationSuggestedAction,
  WeeklyContractActionType,
  WeeklyContractRiskCeiling,
  WeeklyContractStatus,
} from "@/lib/supabase/types";

export type {
  ExecutionAuthorizationOutcome,
  ExecutionAuthorizationReasonCode,
  ExecutionAuthorizationSuggestedAction,
  WeeklyContractActionType,
  WeeklyContractRiskCeiling,
  WeeklyContractStatus,
};

/**
 * Action types the contract may authorize. These are the *only* values
 * the engine will accept; anything else is a hard_block at the
 * boundary.
 */
export const WEEKLY_CONTRACT_ACTION_TYPES = [
  "publish_scheduled_post",
  "publish_scheduled_comment",
  "send_engagement_signal",
  "mark_item_skipped",
  "rotate_to_backlog",
  "open_pr_for_review",
  "request_screenshot_import",
  "request_profile_suggestion",
] as const satisfies ReadonlyArray<WeeklyContractActionType>;

export const WEEKLY_CONTRACT_ACTION_LABELS: Record<
  WeeklyContractActionType,
  string
> = {
  publish_scheduled_post: "Publish a scheduled post",
  publish_scheduled_comment: "Publish a scheduled comment",
  send_engagement_signal: "Send an engagement signal",
  mark_item_skipped: "Mark a plan item skipped",
  rotate_to_backlog: "Rotate an item to the backlog",
  open_pr_for_review: "Open a PR for review",
  request_screenshot_import: "Request a screenshot import",
  request_profile_suggestion: "Request a profile suggestion",
};

/**
 * Action types that are write-side and need contract authorization. The
 * rest (e.g. request_profile_suggestion) are read-side helpers we list
 * here for transparency but which never gate execution by themselves.
 */
export const WEEKLY_CONTRACT_WRITE_ACTIONS = new Set<WeeklyContractActionType>([
  "publish_scheduled_post",
  "publish_scheduled_comment",
  "send_engagement_signal",
  "mark_item_skipped",
  "rotate_to_backlog",
  "open_pr_for_review",
]);

export const WEEKLY_CONTRACT_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "active",
  "paused",
  "expired",
  "revoked",
] as const satisfies ReadonlyArray<WeeklyContractStatus>;

export const WEEKLY_CONTRACT_STATUS_LABELS: Record<WeeklyContractStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  active: "Active",
  paused: "Paused",
  expired: "Expired",
  revoked: "Revoked",
};

export const WEEKLY_CONTRACT_RISK_CEILINGS = ["low", "medium", "high"] as const;

export const RISK_CEILING_RANK: Record<WeeklyContractRiskCeiling, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export const EXECUTION_AUTHORIZATION_OUTCOMES = [
  "allowed",
  "soft_block",
  "hard_block",
] as const satisfies ReadonlyArray<ExecutionAuthorizationOutcome>;

export const EXECUTION_AUTHORIZATION_REASONS = [
  "allowed",
  "no_active_contract",
  "contract_paused",
  "contract_expired",
  "account_out_of_scope",
  "product_out_of_scope",
  "platform_out_of_scope",
  "action_not_permitted",
  "risk_above_ceiling",
  "cadence_total_exceeded",
  "cadence_per_day_exceeded",
  "cadence_per_platform_exceeded",
  "outside_execution_window",
  "paused_by_failure",
  "paused_by_risk_event",
  "demo_mode_blocked",
] as const satisfies ReadonlyArray<ExecutionAuthorizationReasonCode>;

export const EXECUTION_AUTHORIZATION_REASON_LABELS: Record<
  ExecutionAuthorizationReasonCode,
  string
> = {
  allowed: "Allowed by the active contract.",
  no_active_contract: "No active weekly contract.",
  contract_paused: "The contract is paused.",
  contract_expired: "The contract has expired.",
  account_out_of_scope: "Account is not in the contract scope.",
  product_out_of_scope: "Product is not in the contract scope.",
  platform_out_of_scope: "Platform is not in the contract scope.",
  action_not_permitted: "Action type is not permitted by the contract.",
  risk_above_ceiling: "Item risk exceeds the contract ceiling.",
  cadence_total_exceeded: "Weekly action ceiling has been reached.",
  cadence_per_day_exceeded: "Daily action ceiling has been reached.",
  cadence_per_platform_exceeded: "Per-platform daily ceiling has been reached.",
  outside_execution_window: "Outside the approved execution window.",
  paused_by_failure: "Contract auto-paused after a failed action.",
  paused_by_risk_event: "Contract auto-paused after a risk event.",
  demo_mode_blocked: "Execution is disabled in demo mode.",
};

export const EXECUTION_AUTHORIZATION_SUGGESTED_ACTIONS = [
  "proceed",
  "send_to_backlog",
  "reschedule",
  "pause_contract",
  "request_new_approval",
] as const satisfies ReadonlyArray<ExecutionAuthorizationSuggestedAction>;

/**
 * Domain shape of a weekly contract loaded together with its scope
 * tables. The engine consumes this whole envelope when evaluating
 * execution authorization.
 */
export interface WeeklyContract {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  approvedBy: string | null;
  title: string;
  weekStart: string;
  weekEnd: string;
  status: WeeklyContractStatus;
  maxRiskLevel: WeeklyContractRiskCeiling;
  maxActionsTotal: number | null;
  maxActionsPerDay: number | null;
  maxActionsPerPlatformPerDay: number | null;
  pauseOnFirstFailure: boolean;
  pauseOnRiskEvent: boolean;
  notes: string | null;
  approvalTextPhrase: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;

  scope: WeeklyContractScope;
}

export interface WeeklyContractScope {
  accountIds: string[];
  productIds: string[];
  platforms: string[];
  allowedActions: WeeklyContractActionType[];
  executionWindows: ExecutionWindowDef[];
}

export interface ExecutionWindowDef {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}
