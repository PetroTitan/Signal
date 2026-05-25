/**
 * Lightweight observability for the approval transition lifecycle.
 *
 * Mirrors the schedule-events shape (`signal_event` grep key, single
 * sink replaceable for tests, no vendor lock-in). Pure structured
 * logs via console.debug (dev) / console.log (production).
 *
 * SAFE FIELDS ONLY. Never emits:
 *   - tokens, credentials, API keys
 *   - draft body / title content
 *   - operator email / display name
 *
 * Always emits:
 *   - timestamp, action type
 *   - workspace_id, plan_id, plan_item_id (UUIDs only)
 *   - before/after status
 *   - before/after scheduled_at (ISO only)
 *   - failure_reason, mutation_blocked boolean
 */

export type ApprovalEventName =
  | "approval_transition_started"
  | "approval_transition_committed"
  | "approval_transition_failed"
  | "approval_redirect_blocked"
  | "approval_state_assertion_failed"
  | "approval_schedule_mutation_blocked"
  | "approval_schedule_preserved";

export type ApprovalActionType =
  | "approve_weekly_plan"
  | "approve_and_hold"
  | "send_for_approval";

export interface ApprovalEventPayload {
  /** UTC ISO timestamp the event was emitted at. */
  at: string;
  /** Action variant. */
  action: ApprovalActionType;
  /** Workspace UUID. */
  workspaceId: string;
  /** Plan-level UUID (weekly_plan.id). */
  planId?: string | null;
  /** Plan-item-level UUID (weekly_plan_items.id). */
  planItemId?: string | null;
  /** Status prior to mutation. */
  beforeStatus?: string | null;
  /** Status after mutation. */
  afterStatus?: string | null;
  /** Scheduled_at prior to mutation (ISO). */
  beforeScheduledAt?: string | null;
  /** Scheduled_at after mutation (ISO). */
  afterScheduledAt?: string | null;
  /** Calm one-liner — never includes content. */
  failureReason?: string | null;
  /** True for events that represent a blocked mutation. */
  mutationBlocked?: boolean;
  /** Free-form short note (no content / no secrets). */
  detail?: string;
}

type Sink = (event: ApprovalEventName, payload: ApprovalEventPayload) => void;

const defaultSink: Sink = (event, payload) => {
  const line = JSON.stringify({ signal_event: event, ...payload });
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    // eslint-disable-next-line no-console
    console.debug(line);
  }
};

let activeSink: Sink = defaultSink;

/** Test-only sink override. Pass null to restore the default. */
export function __setApprovalEventSink(sink: Sink | null): void {
  activeSink = sink ?? defaultSink;
}

function emit(
  name: ApprovalEventName,
  partial: Omit<ApprovalEventPayload, "at"> & { at?: string },
): void {
  const payload: ApprovalEventPayload = {
    at: partial.at ?? new Date().toISOString(),
    action: partial.action,
    workspaceId: partial.workspaceId,
    planId: partial.planId ?? null,
    planItemId: partial.planItemId ?? null,
    beforeStatus: partial.beforeStatus ?? null,
    afterStatus: partial.afterStatus ?? null,
    beforeScheduledAt: partial.beforeScheduledAt ?? null,
    afterScheduledAt: partial.afterScheduledAt ?? null,
    failureReason: partial.failureReason ?? null,
    mutationBlocked: partial.mutationBlocked,
    detail: partial.detail,
  };
  activeSink(name, payload);
}

// =====================================================================
// Discrete emitters — one export per event for tree-shake friendliness.
// =====================================================================

export function emitApprovalTransitionStarted(
  args: Omit<ApprovalEventPayload, "at" | "mutationBlocked">,
): void {
  emit("approval_transition_started", { ...args, mutationBlocked: false });
}

export function emitApprovalTransitionCommitted(
  args: Omit<ApprovalEventPayload, "at" | "mutationBlocked">,
): void {
  emit("approval_transition_committed", { ...args, mutationBlocked: false });
}

export function emitApprovalTransitionFailed(
  args: Omit<ApprovalEventPayload, "at"> & { failureReason: string },
): void {
  emit("approval_transition_failed", { ...args, mutationBlocked: true });
}

export function emitApprovalRedirectBlocked(
  args: Omit<ApprovalEventPayload, "at"> & { detail: string },
): void {
  emit("approval_redirect_blocked", { ...args, mutationBlocked: true });
}

export function emitApprovalStateAssertionFailed(
  args: Omit<ApprovalEventPayload, "at"> & { failureReason: string },
): void {
  emit("approval_state_assertion_failed", { ...args, mutationBlocked: true });
}

export function emitApprovalScheduleMutationBlocked(
  args: Omit<ApprovalEventPayload, "at"> & { failureReason: string },
): void {
  emit("approval_schedule_mutation_blocked", {
    ...args,
    mutationBlocked: true,
  });
}

export function emitApprovalSchedulePreserved(
  args: Omit<ApprovalEventPayload, "at" | "mutationBlocked">,
): void {
  emit("approval_schedule_preserved", { ...args, mutationBlocked: false });
}
