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
    platform: "reddit",
    contentType: "post",
    subreddit: "test",
    accountId: "",
    productId: "",
    riskScore: "25",
    notes: "",
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
  it("never includes schedule fields", () => {
    const payload = composeAutosavePayload(makeDraft({ title: "hi" }));
    expect(payload).not.toHaveProperty("s");
    expect(payload).not.toHaveProperty("scheduledAt");
    expect(payload.t).toBe("hi");
  });

  it("includes all body/title/platform/etc fields", () => {
    const payload = composeAutosavePayload(
      makeDraft({
        itemId: "abc",
        title: "T",
        body: "B",
        platform: "bluesky",
        contentType: "post",
        subreddit: "test",
        accountId: "a",
        productId: "p",
        riskScore: "30",
        notes: "n",
      }),
    );
    expect(payload).toEqual({
      id: "abc",
      t: "T",
      b: "B",
      p: "bluesky",
      c: "post",
      sr: "test",
      a: "a",
      pr: "p",
      r: "30",
      n: "n",
    });
  });
});

describe("serializeAutosaveDraft", () => {
  it("produces stable identical strings for identical drafts", () => {
    const a = serializeAutosaveDraft(makeDraft({ title: "x" }));
    const b = serializeAutosaveDraft(makeDraft({ title: "x" }));
    expect(a).toEqual(b);
  });

  it("produces different strings when only the title changes", () => {
    const a = serializeAutosaveDraft(makeDraft({ title: "before" }));
    const b = serializeAutosaveDraft(makeDraft({ title: "after" }));
    expect(a).not.toEqual(b);
  });

  it("body edits do not change schedule visibility (schedule never present)", () => {
    const before = serializeAutosaveDraft(makeDraft({ body: "draft" }));
    const after = serializeAutosaveDraft(
      makeDraft({ body: "draft updated" }),
    );
    expect(JSON.parse(before)).not.toHaveProperty("s");
    expect(JSON.parse(after)).not.toHaveProperty("s");
    expect(before).not.toEqual(after);
  });
});
