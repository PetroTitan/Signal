/**
 * Status-driven action state for the compose sheet footer.
 *
 * Pure helpers — no React. Given the plan-item status (and a few
 * blocker flags), returns the structured shape that the modal
 * should render: primary action label, secondary action label,
 * whether each is disabled, and a one-line blocker reason.
 *
 * Status values come from WeeklyPlanItemStatus:
 *   draft | pending_approval | approved | rejected | scheduled |
 *   published | skipped | backlog | paused
 */

export type ComposeItemStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "scheduled"
  | "published"
  | "skipped"
  | "backlog"
  | "paused";

export interface ComposeActionStateInput {
  /** Plan-item status. Null when creating a new item (no row yet). */
  status: ComposeItemStatus | null;
  /** True when an itemId exists (first save completed). */
  hasItemId: boolean;
  /** True when title is non-empty. */
  hasTitle: boolean;
  /** True when alt-text is required but currently missing. */
  altTextMissing: boolean;
  /** True when body autosave is mid-flight. */
  autosaveInFlight: boolean;
  /** True when scheduled_at is set on the item. Used to choose
   *  between the "schedule for publish" CTA (item has time) vs.
   *  the "set a schedule first" hint. Defaults to false. */
  scheduleSet?: boolean;
}

export type ComposeActionVariant =
  | "send_for_approval"
  | "awaiting_approval_actions"
  /** Approved item with a schedule set — operator can promote it
   *  to `scheduled` (creates the execution_item). */
  | "schedule_approved_item"
  /** Approved item without a schedule — operator must set one
   *  before they can schedule for publish. */
  | "schedule_or_mcp"
  | "reschedule_or_unschedule"
  | "read_only";

export interface ComposeActionState {
  /** Which conceptual variant the footer should render. */
  variant: ComposeActionVariant;
  /** Primary CTA label. */
  primaryLabel: string;
  /** True if the primary CTA should be disabled. */
  primaryDisabled: boolean;
  /** Calm reason copy when the primary is disabled. Null when usable. */
  primaryBlocker: string | null;
  /** Whether to also render the secondary "Save as draft" close button. */
  showSaveAsDraft: boolean;
  /** Whether to also render the read-only banner. */
  readOnly: boolean;
}

const READ_ONLY_STATUSES = new Set<ComposeItemStatus>([
  "published",
  "rejected",
  "backlog",
]);

export function deriveComposeActionState(
  input: ComposeActionStateInput,
): ComposeActionState {
  const status = input.status;

  // Create mode (no row yet) — same as draft footer.
  if (status === null || status === "draft" || status === "skipped") {
    const blocker = !input.hasItemId
      ? "Add a title or body to save the draft first."
      : !input.hasTitle
        ? "Add a title before sending for approval."
        : input.autosaveInFlight
          ? "Wait for autosave to settle…"
          : null;
    return {
      variant: "send_for_approval",
      primaryLabel: "Send for approval",
      primaryDisabled: blocker !== null,
      primaryBlocker: blocker,
      showSaveAsDraft: true,
      readOnly: false,
    };
  }

  if (status === "pending_approval") {
    // Per-item approval lives in the modal footer now. The page-wide
    // bulk form still exists for batch operations.
    //
    // The modal renders TWO buttons:
    //   - Approve post (requires schedule)
    //   - Approve & hold (no schedule required)
    //
    // The footer is responsible for disabling the schedule button
    // when no schedule is set; the readiness state below tells it
    // about the alt-text blocker.
    const blocker = input.altTextMissing
      ? "Alt text required before approval and publishing."
      : null;
    return {
      variant: "awaiting_approval_actions",
      primaryLabel: "Approve post",
      primaryDisabled: blocker !== null,
      primaryBlocker: blocker,
      showSaveAsDraft: false,
      readOnly: false,
    };
  }

  if (status === "approved" || status === "paused") {
    // Approved items: branch on whether a schedule is set.
    //   schedule set    → render a real "Schedule for publish"
    //                     button (calls scheduleApprovedItemAction
    //                     which creates the execution_item).
    //   no schedule     → render the existing hint ("Set a schedule
    //                     time above first, or call MCP").
    //
    // Before this branch existed, the modal told operators to "Use
    // the schedule field above" — but the schedule field only saved
    // the timestamp on weekly_plan_items and never created the
    // execution_item the scheduler needs. Posts sat in `approved`
    // status forever.
    if (input.scheduleSet) {
      const blocker = input.altTextMissing
        ? "Alt text required before approval and publishing."
        : null;
      // `paused` means a prior execution attempt
      // (blocked / failed) — this is a retry. Use clearer copy so
      // the operator understands they're recovering, not scheduling
      // for the first time.
      const isRetry = status === "paused";
      return {
        variant: "schedule_approved_item",
        primaryLabel: isRetry ? "Schedule retry" : "Schedule for publish",
        primaryDisabled: blocker !== null,
        primaryBlocker:
          blocker ??
          (isRetry
            ? "Paused after a failed or blocked attempt. Schedule again to retry."
            : null),
        showSaveAsDraft: false,
        readOnly: false,
      };
    }
    return {
      variant: "schedule_or_mcp",
      primaryLabel: "Schedule",
      primaryDisabled: false,
      primaryBlocker: null,
      showSaveAsDraft: false,
      readOnly: false,
    };
  }

  if (status === "scheduled") {
    return {
      variant: "reschedule_or_unschedule",
      primaryLabel: "Reschedule",
      primaryDisabled: false,
      primaryBlocker: null,
      showSaveAsDraft: false,
      readOnly: false,
    };
  }

  if (READ_ONLY_STATUSES.has(status)) {
    return {
      variant: "read_only",
      primaryLabel: "Close",
      primaryDisabled: false,
      primaryBlocker: null,
      showSaveAsDraft: false,
      readOnly: true,
    };
  }

  // Defensive fallback — unknown status. Render read-only.
  return {
    variant: "read_only",
    primaryLabel: "Close",
    primaryDisabled: false,
    primaryBlocker: null,
    showSaveAsDraft: false,
    readOnly: true,
  };
}
