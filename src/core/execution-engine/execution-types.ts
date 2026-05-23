/**
 * Phase E2 — Execution Engine canonical types.
 *
 * Mirrors the CHECK constraints in
 *   supabase/migrations/20260522050001_phase_e2_execution_schema.sql
 *
 * The action types come from the weekly contract's allowed-action
 * vocabulary plus a few dry-run-only variants the engine uses to
 * describe "what would have happened" without touching external
 * platforms.
 */

import type {
  ExecutionAttemptStatus,
  ExecutionItemRiskLevel,
  ExecutionItemStatus,
  ExecutionLogSeverity,
  ExecutionQueueStatus,
} from "@/lib/supabase/types";
import type { WeeklyContractActionType } from "@/core/weekly-contract";

export type {
  ExecutionAttemptStatus,
  ExecutionItemRiskLevel,
  ExecutionItemStatus,
  ExecutionLogSeverity,
  ExecutionQueueStatus,
};

/**
 * Dry-run synthetic action labels. The engine writes these into log
 * messages so operators can see exactly what *would* have happened if
 * external publishing were wired.
 *
 * They are not stored as a separate column; they appear in
 * `execution_logs.metadata.dry_run_action` and in the human-readable
 * log message.
 */
export const DRY_RUN_ACTIONS = [
  "would_publish_post",
  "would_publish_comment",
  "would_schedule_item",
  "would_move_to_backlog",
  "would_skip_risky_thread",
  "would_send_engagement_signal",
  "would_open_pr_for_review",
] as const;
export type DryRunAction = (typeof DRY_RUN_ACTIONS)[number];

export function dryRunActionForAction(
  action: WeeklyContractActionType,
): DryRunAction {
  switch (action) {
    case "publish_scheduled_post":
      return "would_publish_post";
    case "publish_scheduled_comment":
      return "would_publish_comment";
    case "send_engagement_signal":
      return "would_send_engagement_signal";
    case "rotate_to_backlog":
      return "would_move_to_backlog";
    case "mark_item_skipped":
      return "would_skip_risky_thread";
    case "open_pr_for_review":
      return "would_open_pr_for_review";
    default:
      return "would_schedule_item";
  }
}

/**
 * Final (terminal) execution item statuses. The state machine refuses
 * to transition out of these.
 */
export const FINAL_ITEM_STATUSES = new Set<ExecutionItemStatus>([
  "completed",
  "cancelled",
  "skipped",
  "blocked",
  "backlogged",
]);

export const FINAL_QUEUE_STATUSES = new Set<ExecutionQueueStatus>([
  "completed",
  "cancelled",
  "failed",
]);

export const EXECUTION_QUEUE_STATUS_LABELS: Record<
  ExecutionQueueStatus,
  string
> = {
  draft: "Draft",
  ready: "Ready",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const EXECUTION_ITEM_STATUS_LABELS: Record<
  ExecutionItemStatus,
  string
> = {
  pending_authorization: "Pending authorization",
  authorized: "Authorized",
  scheduled: "Scheduled",
  ready: "Ready",
  ready_for_manual_publish: "Ready for manual publish",
  running: "Running",
  completed: "Completed",
  blocked: "Blocked",
  backlogged: "Backlogged",
  skipped: "Skipped",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Domain shape of an execution queue. Repositories convert DB rows
 * into this shape so the engine and UI never touch raw snake_case.
 */
export interface ExecutionQueue {
  id: string;
  workspaceId: string;
  contractId: string;
  createdBy: string | null;
  title: string;
  status: ExecutionQueueStatus;
  weekStart: string;
  weekEnd: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionItem {
  id: string;
  workspaceId: string;
  queueId: string;
  contractId: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  productId: string | null;
  accountId: string | null;
  platform: string | null;
  actionType: string;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  scheduledAt: string | null;
  status: ExecutionItemStatus;
  riskScore: number | null;
  riskLevel: ExecutionItemRiskLevel | null;
  authorizationId: string | null;
  attemptCount: number;
  maxAttempts: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionLog {
  id: string;
  workspaceId: string;
  queueId: string | null;
  executionItemId: string | null;
  eventType: string;
  severity: ExecutionLogSeverity;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionAttempt {
  id: string;
  workspaceId: string;
  executionItemId: string;
  attemptNumber: number;
  status: ExecutionAttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
