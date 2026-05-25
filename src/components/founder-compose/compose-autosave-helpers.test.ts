import { describe, expect, it } from "vitest";
import {
  composeAutosavePayload,
  serializeAutosaveDraft,
  shouldResetDraft,
  type ComposeAutosaveDraft,
} from "./compose-autosave-helpers";

function makeDraft(
  overrides: Partial<ComposeAutosaveDraft> = {},
): ComposeAutosaveDraft {
  return {
    itemId: null,
    title: "",
    body: "",
    scheduledAt: "2026-05-20T16:01",
    platform: "reddit",
    contentType: "post",
    subreddit: "test",
    accountId: "",
    productId: "",
    riskScore: "25",
    notes: "",
    scheduledAtTouched: false,
    ...overrides,
  };
}

describe("shouldResetDraft", () => {
  it("returns true on a closed → open transition", () => {
    expect(shouldResetDraft(false, true)).toBe(true);
  });

  it("returns false when staying open", () => {
    expect(shouldResetDraft(true, true)).toBe(false);
  });

  it("returns false when staying closed", () => {
    expect(shouldResetDraft(false, false)).toBe(false);
  });

  it("returns false on an open → closed transition", () => {
    expect(shouldResetDraft(true, false)).toBe(false);
  });
});

describe("composeAutosavePayload", () => {
  it("omits the schedule field when scheduledAtTouched is false", () => {
    const payload = composeAutosavePayload(
      makeDraft({ scheduledAtTouched: false, title: "hi" }),
    );
    expect(payload).not.toHaveProperty("s");
    expect(payload.t).toBe("hi");
  });

  it("includes the schedule field when scheduledAtTouched is true", () => {
    const payload = composeAutosavePayload(
      makeDraft({ scheduledAtTouched: true, title: "hi" }),
    );
    expect(payload.s).toBe("2026-05-20T16:01");
  });
});

describe("serializeAutosaveDraft", () => {
  it("produces the same string for two drafts that differ only in scheduledAt while untouched", () => {
    const a = serializeAutosaveDraft(
      makeDraft({
        scheduledAt: "2026-05-20T16:01",
        scheduledAtTouched: false,
      }),
    );
    const b = serializeAutosaveDraft(
      makeDraft({
        scheduledAt: "2026-05-20T12:01",
        scheduledAtTouched: false,
      }),
    );
    // Same payload — the schedule diff is invisible to the autosave
    // loop until the operator actually touches the picker.
    expect(a).toEqual(b);
  });

  it("produces different strings when only the title changes", () => {
    const a = serializeAutosaveDraft(makeDraft({ title: "before" }));
    const b = serializeAutosaveDraft(makeDraft({ title: "after" }));
    expect(a).not.toEqual(b);
  });

  it("produces different strings when scheduledAt changes after touching", () => {
    const a = serializeAutosaveDraft(
      makeDraft({
        scheduledAt: "2026-05-20T16:01",
        scheduledAtTouched: true,
      }),
    );
    const b = serializeAutosaveDraft(
      makeDraft({
        scheduledAt: "2026-05-20T17:01",
        scheduledAtTouched: true,
      }),
    );
    expect(a).not.toEqual(b);
  });

  it("body edits do not change the schedule payload visibility", () => {
    const before = serializeAutosaveDraft(
      makeDraft({ body: "draft", scheduledAtTouched: false }),
    );
    const after = serializeAutosaveDraft(
      makeDraft({ body: "draft updated", scheduledAtTouched: false }),
    );
    // body changed, but s is absent from both payloads
    expect(JSON.parse(before)).not.toHaveProperty("s");
    expect(JSON.parse(after)).not.toHaveProperty("s");
    expect(before).not.toEqual(after);
  });
});
