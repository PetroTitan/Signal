import { describe, expect, it } from "vitest";
import { deriveApproveActionsState } from "./approve-actions-ui";

describe("deriveApproveActionsState — happy path", () => {
  it("schedule + contract → both enabled, no context hint", () => {
    const s = deriveApproveActionsState({
      scheduleSet: true,
      hasActiveContract: true,
    });
    expect(s.schedulePost.kind).toBe("enabled");
    expect(s.approveAndHold.kind).toBe("enabled");
    expect(s.contextHint).toBe(null);
  });
});

describe("deriveApproveActionsState — no active contract", () => {
  it("schedule disabled, hold enabled, context hint explains contract", () => {
    const s = deriveApproveActionsState({
      scheduleSet: true,
      hasActiveContract: false,
    });
    expect(s.schedulePost.kind).toBe("disabled_no_contract");
    expect(s.approveAndHold.kind).toBe("enabled");
    expect(s.contextHint).toMatch(/active weekly contract/i);
    expect(s.contextHint).toMatch(/approve & hold/i);
  });

  it("schedule slot carries the contract hint text on the disabled state", () => {
    const s = deriveApproveActionsState({
      scheduleSet: true,
      hasActiveContract: false,
    });
    if (s.schedulePost.kind === "disabled_no_contract") {
      expect(s.schedulePost.hint).toMatch(/contract/i);
    } else {
      throw new Error("expected disabled_no_contract");
    }
  });

  it("hold path stays enabled even when schedule is also missing", () => {
    const s = deriveApproveActionsState({
      scheduleSet: false,
      hasActiveContract: false,
    });
    expect(s.approveAndHold.kind).toBe("enabled");
  });
});

describe("deriveApproveActionsState — no schedule", () => {
  it("schedule disabled with no-schedule hint, hold enabled", () => {
    const s = deriveApproveActionsState({
      scheduleSet: false,
      hasActiveContract: true,
    });
    expect(s.schedulePost.kind).toBe("disabled_no_schedule");
    expect(s.approveAndHold.kind).toBe("enabled");
    expect(s.contextHint).toMatch(/schedule/i);
  });
});

describe("deriveApproveActionsState — other blocker present", () => {
  it("both buttons disabled with the same blocker hint", () => {
    const s = deriveApproveActionsState({
      scheduleSet: true,
      hasActiveContract: true,
      otherBlocker: "Alt text required before approval and publishing.",
    });
    expect(s.schedulePost.kind).toBe("disabled_other");
    expect(s.approveAndHold.kind).toBe("disabled_other");
    if (
      s.schedulePost.kind === "disabled_other" &&
      s.approveAndHold.kind === "disabled_other"
    ) {
      expect(s.schedulePost.hint).toContain("Alt text");
      expect(s.approveAndHold.hint).toContain("Alt text");
    }
  });

  it("other blocker takes precedence over missing contract", () => {
    const s = deriveApproveActionsState({
      scheduleSet: true,
      hasActiveContract: false,
      otherBlocker: "Creative is missing. Upload an asset or generate one.",
    });
    expect(s.schedulePost.kind).toBe("disabled_other");
    expect(s.approveAndHold.kind).toBe("disabled_other");
  });
});

describe("deriveApproveActionsState — invariants", () => {
  it("Approve post is NEVER enabled without an active contract", () => {
    for (const scheduleSet of [true, false]) {
      const s = deriveApproveActionsState({
        scheduleSet,
        hasActiveContract: false,
      });
      expect(s.schedulePost.kind).not.toBe("enabled");
    }
  });

  it("Approve post is NEVER enabled without a schedule", () => {
    for (const hasActiveContract of [true, false]) {
      const s = deriveApproveActionsState({
        scheduleSet: false,
        hasActiveContract,
      });
      expect(s.schedulePost.kind).not.toBe("enabled");
    }
  });

  it("Approve & hold is always enabled when there's no other blocker", () => {
    for (const scheduleSet of [true, false]) {
      for (const hasActiveContract of [true, false]) {
        const s = deriveApproveActionsState({
          scheduleSet,
          hasActiveContract,
        });
        expect(s.approveAndHold.kind).toBe("enabled");
      }
    }
  });
});
