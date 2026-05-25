import { describe, expect, it } from "vitest";
import {
  deriveComposeActionState,
  type ComposeActionStateInput,
  type ComposeItemStatus,
} from "./compose-action-state";

function makeInput(
  overrides: Partial<ComposeActionStateInput> = {},
): ComposeActionStateInput {
  return {
    status: "draft",
    hasItemId: true,
    hasTitle: true,
    altTextMissing: false,
    autosaveInFlight: false,
    ...overrides,
  };
}

describe("deriveComposeActionState — draft / skipped / create mode", () => {
  it("draft: shows Send for approval as primary, Save as draft as secondary", () => {
    const s = deriveComposeActionState(makeInput({ status: "draft" }));
    expect(s.variant).toBe("send_for_approval");
    expect(s.primaryLabel).toBe("Send for approval");
    expect(s.primaryDisabled).toBe(false);
    expect(s.showSaveAsDraft).toBe(true);
    expect(s.readOnly).toBe(false);
  });

  it("skipped: same as draft", () => {
    const s = deriveComposeActionState(makeInput({ status: "skipped" }));
    expect(s.variant).toBe("send_for_approval");
    expect(s.primaryLabel).toBe("Send for approval");
  });

  it("create mode (status=null): treated as draft", () => {
    const s = deriveComposeActionState(makeInput({ status: null }));
    expect(s.variant).toBe("send_for_approval");
  });

  it("blocks Send for approval when there's no item id yet", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "draft", hasItemId: false }),
    );
    expect(s.primaryDisabled).toBe(true);
    expect(s.primaryBlocker).toMatch(/title or body/i);
  });

  it("blocks Send for approval when title is empty", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "draft", hasTitle: false }),
    );
    expect(s.primaryDisabled).toBe(true);
    expect(s.primaryBlocker).toMatch(/title/i);
  });

  it("blocks Send for approval while autosave is in flight", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "draft", autosaveInFlight: true }),
    );
    expect(s.primaryDisabled).toBe(true);
    expect(s.primaryBlocker).toMatch(/autosave/i);
  });
});

describe("deriveComposeActionState — pending_approval", () => {
  it("does NOT show Send for approval", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "pending_approval" }),
    );
    expect(s.variant).not.toBe("send_for_approval");
    expect(s.primaryLabel).not.toBe("Send for approval");
  });

  it("variant is open_approval_queue", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "pending_approval" }),
    );
    expect(s.variant).toBe("open_approval_queue");
  });

  it("blocks approval when alt text is missing", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "pending_approval", altTextMissing: true }),
    );
    expect(s.primaryDisabled).toBe(true);
    expect(s.primaryBlocker).toMatch(/alt text/i);
    expect(s.primaryBlocker).toMatch(/before approval/i);
  });

  it("hides Save as draft (item is not a draft anymore)", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "pending_approval" }),
    );
    expect(s.showSaveAsDraft).toBe(false);
  });
});

describe("deriveComposeActionState — approved", () => {
  it("does NOT show Send for approval", () => {
    const s = deriveComposeActionState(makeInput({ status: "approved" }));
    expect(s.variant).not.toBe("send_for_approval");
  });

  it("variant is schedule_or_mcp", () => {
    const s = deriveComposeActionState(makeInput({ status: "approved" }));
    expect(s.variant).toBe("schedule_or_mcp");
  });

  it("paused items use the same variant", () => {
    const s = deriveComposeActionState(makeInput({ status: "paused" }));
    expect(s.variant).toBe("schedule_or_mcp");
  });
});

describe("deriveComposeActionState — scheduled", () => {
  it("does NOT show Send for approval", () => {
    const s = deriveComposeActionState(makeInput({ status: "scheduled" }));
    expect(s.variant).not.toBe("send_for_approval");
  });

  it("variant is reschedule_or_unschedule", () => {
    const s = deriveComposeActionState(makeInput({ status: "scheduled" }));
    expect(s.variant).toBe("reschedule_or_unschedule");
  });
});

describe("deriveComposeActionState — read-only states", () => {
  it.each<ComposeItemStatus>(["published", "rejected", "backlog"])(
    "status=%s is read-only",
    (status) => {
      const s = deriveComposeActionState(makeInput({ status }));
      expect(s.readOnly).toBe(true);
      expect(s.variant).toBe("read_only");
      expect(s.showSaveAsDraft).toBe(false);
    },
  );
});

describe("deriveComposeActionState — invariants", () => {
  it.each<ComposeItemStatus>([
    "pending_approval",
    "approved",
    "scheduled",
    "published",
    "rejected",
    "backlog",
  ])("status=%s never produces variant='send_for_approval'", (status) => {
    const s = deriveComposeActionState(makeInput({ status }));
    expect(s.variant).not.toBe("send_for_approval");
  });

  it("primary blocker is never falsy when disabled is true", () => {
    const s = deriveComposeActionState(
      makeInput({ status: "draft", hasTitle: false }),
    );
    if (s.primaryDisabled) {
      expect(s.primaryBlocker).not.toBe(null);
      expect(s.primaryBlocker?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
