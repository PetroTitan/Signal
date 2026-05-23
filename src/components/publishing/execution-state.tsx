/**
 * Human-readable execution state mapping + visual badge.
 *
 * The DB carries technical enum names ("pending_authorization",
 * "ready_for_manual_publish") that leak operational implementation
 * into the UI. This module maps those onto founder-readable labels
 * + descriptions + a small tone (color/icon) for the badge.
 *
 * Used by /weekly-plan, /approval-queue, /execution, and the
 * /execution/items/<id> detail page.
 */

import type {
  ExecutionItemStatus,
  WeeklyPlanItemStatus,
} from "@/lib/supabase/types";

export type FounderState =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "ready_for_publish"
  | "ready_for_manual_publish"
  | "publishing"
  | "published"
  | "skipped"
  | "blocked"
  | "failed"
  | "paused"
  | "archived";

interface FounderStateMeta {
  label: string;
  /** One-line description for tooltips / empty states. */
  hint: string;
  tone: "neutral" | "info" | "success" | "warn" | "danger" | "muted";
}

const STATE_META: Record<FounderState, FounderStateMeta> = {
  draft: {
    label: "Draft",
    hint: "Not yet sent for approval.",
    tone: "muted",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    hint: "Waiting for your approval before it can publish.",
    tone: "warn",
  },
  approved: {
    label: "Approved",
    hint: "Approved and lined up to publish at the scheduled time.",
    tone: "info",
  },
  scheduled: {
    label: "Scheduled",
    hint: "Will publish at its scheduled time.",
    tone: "info",
  },
  ready_for_publish: {
    label: "Ready to publish",
    hint: "Ready to go out. Open the post to confirm and publish.",
    tone: "success",
  },
  ready_for_manual_publish: {
    label: "Ready to publish manually",
    hint: "Open the post to copy it, publish on Reddit, and paste the permalink back.",
    tone: "success",
  },
  publishing: {
    label: "Publishing",
    hint: "Sending the post now.",
    tone: "info",
  },
  published: {
    label: "Published",
    hint: "Live on the platform.",
    tone: "success",
  },
  skipped: {
    label: "Skipped",
    hint: "A safety check held this back. Signal will try again automatically.",
    tone: "warn",
  },
  blocked: {
    label: "Blocked",
    hint: "A safety check stopped this. Fix the issue and approve again.",
    tone: "danger",
  },
  failed: {
    label: "Failed",
    hint: "The platform refused the post. Open it to see what happened.",
    tone: "danger",
  },
  paused: {
    label: "Paused",
    hint: "On hold. Resume to bring it back into your publishing plan.",
    tone: "muted",
  },
  archived: {
    label: "Archived",
    hint: "Set aside. No longer in your active publishing plan.",
    tone: "muted",
  },
};

const TONE_CLASS: Record<FounderStateMeta["tone"], string> = {
  neutral: "bg-ink-100 text-ink-700 border-ink-200",
  info: "bg-signal-50 text-signal-700 border-signal-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  muted: "bg-ink-50 text-ink-500 border-ink-100",
};

const TONE_DOT: Record<FounderStateMeta["tone"], string> = {
  neutral: "bg-ink-400",
  info: "bg-signal-500",
  success: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-ink-300",
};

/**
 * Map a DB execution_items.status onto the founder-readable label.
 */
export function executionItemToFounderState(
  status: ExecutionItemStatus,
): FounderState {
  switch (status) {
    case "pending_authorization":
      return "awaiting_approval";
    case "authorized":
      return "approved";
    case "scheduled":
      return "scheduled";
    case "ready":
      return "ready_for_publish";
    case "ready_for_manual_publish":
      return "ready_for_manual_publish";
    case "running":
      return "publishing";
    case "completed":
      return "published";
    case "blocked":
      return "blocked";
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "backlogged":
      return "archived";
    case "cancelled":
      return "archived";
  }
}

/**
 * Map a DB weekly_plan_items.status onto the founder-readable label.
 */
export function weeklyPlanItemToFounderState(
  status: WeeklyPlanItemStatus,
): FounderState {
  switch (status) {
    case "draft":
      return "draft";
    case "pending_approval":
      return "awaiting_approval";
    case "approved":
      return "approved";
    case "rejected":
      return "archived";
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
    case "skipped":
      return "skipped";
    case "backlog":
      return "archived";
    case "paused":
      return "paused";
  }
}

export function humanReadableExecutionState(
  status: ExecutionItemStatus | WeeklyPlanItemStatus,
): FounderStateMeta {
  // Try execution first, then fall back to weekly_plan_item. The
  // overlap (e.g. "scheduled", "published") returns identical
  // metadata, so the order doesn't matter for shared labels.
  const execStates = new Set<string>([
    "pending_authorization",
    "authorized",
    "scheduled",
    "ready",
    "ready_for_manual_publish",
    "running",
    "completed",
    "blocked",
    "skipped",
    "failed",
    "paused",
    "backlogged",
    "cancelled",
  ]);
  const state = execStates.has(status)
    ? executionItemToFounderState(status as ExecutionItemStatus)
    : weeklyPlanItemToFounderState(status as WeeklyPlanItemStatus);
  return STATE_META[state];
}

export interface StateBadgeProps {
  state: FounderState;
  /** Small inline pill. Default. */
  size?: "sm" | "md";
}

export function StateBadge({ state, size = "sm" }: StateBadgeProps) {
  const meta = STATE_META[state];
  const cls = TONE_CLASS[meta.tone];
  const dot = TONE_DOT[meta.tone];
  const pad = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${cls} ${pad}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * Convenience: take a DB enum, render the badge directly.
 */
export function ExecutionStateBadge({
  status,
  size,
}: {
  status: ExecutionItemStatus | WeeklyPlanItemStatus;
  size?: "sm" | "md";
}) {
  const execStates = new Set<string>([
    "pending_authorization",
    "authorized",
    "scheduled",
    "ready",
    "ready_for_manual_publish",
    "running",
    "completed",
    "blocked",
    "skipped",
    "failed",
    "paused",
    "backlogged",
    "cancelled",
  ]);
  const state = execStates.has(status)
    ? executionItemToFounderState(status as ExecutionItemStatus)
    : weeklyPlanItemToFounderState(status as WeeklyPlanItemStatus);
  return <StateBadge state={state} size={size} />;
}
