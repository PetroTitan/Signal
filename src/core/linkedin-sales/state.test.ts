import { describe, expect, it } from "vitest";
import {
  canTransitionCampaign,
  canTransitionMember,
  canTransitionTask,
  CONFIRMABLE_TASK_STATES,
  isReleasableTaskKind,
  isSequenceStepKind,
  MEMBER_STATE_LABELS,
  memberReasonLabel,
  RELEASABLE_TASK_KINDS,
  SEQUENCE_STEP_KINDS,
  STEP_KIND_LABELS,
  TASK_KIND_LABELS,
  TASK_STATE_LABELS,
  TERMINAL_TASK_STATES,
} from "./state";

describe("task state machine", () => {
  it("only a person's confirmation completes a task, and only from ready/opened/copied", () => {
    expect(CONFIRMABLE_TASK_STATES).toEqual(["ready", "opened", "copied"]);
    expect(canTransitionTask("scheduled", "operator_confirmed")).toBe(false);
    for (const t of TERMINAL_TASK_STATES) {
      for (const to of ["ready", "opened", "copied", "operator_confirmed", "skipped", "cancelled"] as const) {
        expect(canTransitionTask(t, to), `${t} → ${to}`).toBe(false);
      }
    }
  });

  it("opening and copying are recordings on the way, never completion", () => {
    expect(canTransitionTask("ready", "opened")).toBe(true);
    expect(canTransitionTask("opened", "copied")).toBe(true);
    // There is no transition named "sent" and no state that means it.
    expect(Object.keys(TASK_STATE_LABELS)).not.toContain("sent");
    for (const label of Object.values(TASK_STATE_LABELS)) {
      expect(label).not.toMatch(/\bsent\b/i);
      expect(label).not.toMatch(/provider confirmed/i);
    }
  });
});

describe("member and campaign state machines", () => {
  it("every terminal member state is final and explainable", () => {
    for (const from of ["completed", "suppressed", "operator_skipped", "structurally_invalid", "cancelled"] as const) {
      expect(canTransitionMember(from, "waiting")).toBe(false);
      expect(MEMBER_STATE_LABELS[from]).toBeTruthy();
    }
    expect(canTransitionMember("waiting", "completed")).toBe(true);
  });

  it("a campaign pauses and resumes; completed and cancelled are final", () => {
    expect(canTransitionCampaign("draft", "active")).toBe(true);
    expect(canTransitionCampaign("active", "paused")).toBe(true);
    expect(canTransitionCampaign("paused", "active")).toBe(true);
    expect(canTransitionCampaign("completed", "active")).toBe(false);
    expect(canTransitionCampaign("cancelled", "active")).toBe(false);
  });
});

describe("closed kinds", () => {
  it("there is no automatic LinkedIn kind of anything", () => {
    for (const kind of SEQUENCE_STEP_KINDS) {
      expect(kind).not.toMatch(/auto|api|send/);
    }
    expect(isSequenceStepKind("automatic_linkedin_message")).toBe(false);
    expect(isSequenceStepKind("manual_linkedin_message")).toBe(true);
  });

  it("an unknown kind is not releasable — fail closed", () => {
    expect(isReleasableTaskKind("manual_profile_review")).toBe(true);
    expect(isReleasableTaskKind("authorized_email")).toBe(false);
    expect(isReleasableTaskKind("wait")).toBe(false);
    expect(isReleasableTaskKind("something_new")).toBe(false);
    expect(RELEASABLE_TASK_KINDS).not.toContain("authorized_email");
  });

  it("every label says who does the LinkedIn part: you", () => {
    expect(TASK_KIND_LABELS.manual_connection_request).toMatch(/you send it on LinkedIn/);
    expect(TASK_KIND_LABELS.manual_linkedin_message).toMatch(/you send it on LinkedIn/);
    expect(STEP_KIND_LABELS.wait).toMatch(/pause/);
    for (const label of Object.values(TASK_KIND_LABELS)) {
      expect(label).not.toMatch(/automatic|automatically|Signal sends/i);
    }
  });

  it("member reasons render in the operator's words, and unknown kinds say nothing was guessed", () => {
    expect(memberReasonLabel("unknown_step_kind:x")).toMatch(/Nothing was guessed/);
    expect(memberReasonLabel("suppression_list")).toMatch(/suppression list/);
    expect(memberReasonLabel(null)).toBeNull();
  });
});
