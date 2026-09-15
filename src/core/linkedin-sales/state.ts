/**
 * The state machines of the LinkedIn Sales workspace, as pure tables.
 *
 * The database CHECKs and functions enforce these; this module is what
 * the repository, the actions and the UI consult before asking, so a
 * refused transition is refused with a sentence rather than a
 * constraint error. Nothing here is a source of truth on its own.
 *
 * THE RULE THAT MATTERS MOST
 * --------------------------
 * A task is completed only by `operator_confirmed`, and only a person
 * sets it. `opened` and `copied` are recordings of what the operator
 * did in Signal; they never imply anything happened on LinkedIn.
 */

import type {
  LinkedInCampaignStatus,
  LinkedInMemberState,
  LinkedInSequenceStepKind,
  LinkedInTaskKind,
  LinkedInTaskState,
} from "@/lib/supabase/types";

export const TASK_STATES: readonly LinkedInTaskState[] = [
  "scheduled", "ready", "opened", "copied", "operator_confirmed", "skipped", "cancelled",
];
export const TERMINAL_TASK_STATES: readonly LinkedInTaskState[] = ["operator_confirmed", "skipped", "cancelled"];
export const OPEN_TASK_STATES: readonly LinkedInTaskState[] = ["scheduled", "ready", "opened", "copied"];

const TASK_TRANSITIONS: Record<LinkedInTaskState, readonly LinkedInTaskState[]> = {
  scheduled: ["ready", "cancelled", "skipped"],
  ready: ["opened", "copied", "operator_confirmed", "skipped", "cancelled"],
  opened: ["copied", "operator_confirmed", "skipped", "cancelled"],
  copied: ["operator_confirmed", "skipped", "cancelled"],
  operator_confirmed: [],
  skipped: [],
  cancelled: [],
};

export function canTransitionTask(from: LinkedInTaskState, to: LinkedInTaskState): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The states from which an operator may confirm. Never scheduled, never terminal. */
export const CONFIRMABLE_TASK_STATES: readonly LinkedInTaskState[] = ["ready", "opened", "copied"];

export const MEMBER_STATES: readonly LinkedInMemberState[] = [
  "waiting", "completed", "suppressed", "operator_skipped", "structurally_invalid", "cancelled",
];
export const TERMINAL_MEMBER_STATES: readonly LinkedInMemberState[] = [
  "completed", "suppressed", "operator_skipped", "structurally_invalid", "cancelled",
];

const MEMBER_TRANSITIONS: Record<LinkedInMemberState, readonly LinkedInMemberState[]> = {
  waiting: ["completed", "suppressed", "operator_skipped", "structurally_invalid", "cancelled"],
  completed: [],
  suppressed: [],
  operator_skipped: [],
  structurally_invalid: [],
  cancelled: [],
};

export function canTransitionMember(from: LinkedInMemberState, to: LinkedInMemberState): boolean {
  return MEMBER_TRANSITIONS[from]?.includes(to) ?? false;
}

const CAMPAIGN_TRANSITIONS: Record<LinkedInCampaignStatus, readonly LinkedInCampaignStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionCampaign(from: LinkedInCampaignStatus, to: LinkedInCampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The closed set. Mirrors the CHECK on linkedin_sequence_steps.kind. */
export const SEQUENCE_STEP_KINDS: readonly LinkedInSequenceStepKind[] = [
  "manual_connection_request",
  "manual_linkedin_message",
  "manual_profile_review",
  "wait",
  "internal_note",
  "authorized_email",
];

/** Kinds that become a manual task. A wait never does. */
export const TASK_KINDS: readonly LinkedInTaskKind[] = [
  "manual_connection_request",
  "manual_linkedin_message",
  "manual_profile_review",
  "internal_note",
  "authorized_email",
];

/**
 * Kinds the scheduler will prepare a task for in THIS release.
 * `authorized_email` is in the closed set but has no authorized
 * integration; activation refuses it and the release function marks a
 * member that reaches one `structurally_invalid`. Anything else is
 * unknown and fails closed the same way.
 */
export const RELEASABLE_TASK_KINDS: readonly LinkedInTaskKind[] = [
  "manual_connection_request",
  "manual_linkedin_message",
  "manual_profile_review",
  "internal_note",
];

export function isSequenceStepKind(value: string): value is LinkedInSequenceStepKind {
  return (SEQUENCE_STEP_KINDS as readonly string[]).includes(value);
}

export function isReleasableTaskKind(value: string): value is LinkedInTaskKind {
  return (RELEASABLE_TASK_KINDS as readonly string[]).includes(value);
}

/** Operator-facing words. Truthful by construction: nothing here says "sent". */
export const TASK_KIND_LABELS: Record<LinkedInTaskKind, string> = {
  manual_connection_request: "Connection request — you send it on LinkedIn",
  manual_linkedin_message: "Message — you send it on LinkedIn",
  manual_profile_review: "Profile review — you look, then decide",
  internal_note: "Internal note — for you, not for LinkedIn",
  authorized_email: "Email through an authorized integration (not available in this release)",
};

export const STEP_KIND_LABELS: Record<LinkedInSequenceStepKind, string> = {
  ...TASK_KIND_LABELS,
  wait: "Wait — a pause before the next step",
};

export const TASK_STATE_LABELS: Record<LinkedInTaskState, string> = {
  scheduled: "Scheduled — not yet ready",
  ready: "Ready for you",
  opened: "Profile opened in LinkedIn (by you)",
  copied: "Draft copied (by you)",
  operator_confirmed: "Operator confirmed",
  skipped: "Skipped by you",
  cancelled: "Cancelled",
};

export const MEMBER_STATE_LABELS: Record<LinkedInMemberState, string> = {
  waiting: "Waiting for the next step",
  completed: "Completed — every step confirmed by you",
  suppressed: "Suppressed — will not be prepared",
  operator_skipped: "Skipped by you",
  structurally_invalid: "Cannot be prepared — see reason",
  cancelled: "Cancelled",
};

export const CAMPAIGN_STATUS_LABELS: Record<LinkedInCampaignStatus, string> = {
  draft: "Draft",
  active: "Preparing tasks",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Member reason codes the scheduler and functions write, in the operator's words. */
export const MEMBER_REASON_LABELS: Record<string, string> = {
  suppression_list: "On the workspace suppression list.",
  do_not_contact: "Marked do-not-contact.",
  lead_deleted: "The lead was deleted.",
  campaign_cancelled: "The campaign was cancelled before this lead was reached.",
  sequence_position_gap: "The sequence has a gap in its step order; fix the sequence.",
  email_integration_unavailable: "The sequence has an email step and no email integration is authorized.",
};

export function memberReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.startsWith("unknown_step_kind:")) {
    return `The step kind "${reason.slice("unknown_step_kind:".length)}" is not one Signal can prepare. Nothing was guessed.`;
  }
  return MEMBER_REASON_LABELS[reason] ?? reason;
}
