import { describe, expect, it } from "vitest";
import { parseScheduledAtField } from "./parse-scheduled-at-field";

function makeForm(entries: Record<string, string> | null): FormData {
  const fd = new FormData();
  if (entries) {
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  }
  return fd;
}

describe("parseScheduledAtField", () => {
  it("returns skip when the field is absent", () => {
    const fd = makeForm({ title: "hi" });
    expect(parseScheduledAtField(fd)).toEqual({ kind: "skip" });
  });

  it("returns clear when the field is an empty string", () => {
    const fd = makeForm({ scheduled_at: "" });
    expect(parseScheduledAtField(fd)).toEqual({ kind: "clear" });
  });

  it("returns clear when the field is whitespace only", () => {
    const fd = makeForm({ scheduled_at: "   " });
    expect(parseScheduledAtField(fd)).toEqual({ kind: "clear" });
  });

  it("returns set with normalized ISO when the field has a Z suffix", () => {
    const fd = makeForm({ scheduled_at: "2026-05-20T20:01:00.000Z" });
    expect(parseScheduledAtField(fd)).toEqual({
      kind: "set",
      iso: "2026-05-20T20:01:00.000Z",
    });
  });

  it("returns set with normalized ISO when the field has a +/-HH:MM offset", () => {
    const fd = makeForm({ scheduled_at: "2026-05-20T16:01:00-04:00" });
    const result = parseScheduledAtField(fd);
    expect(result).toEqual({
      kind: "set",
      iso: "2026-05-20T20:01:00.000Z",
    });
  });

  it("rejects bare datetime-local strings (no timezone)", () => {
    const fd = makeForm({ scheduled_at: "2026-05-20T16:01" });
    const result = parseScheduledAtField(fd);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/fully-qualified|timezone/i);
    }
  });

  it("rejects garbage strings with TZ-like suffix but invalid date", () => {
    const fd = makeForm({ scheduled_at: "not-a-date-Z" });
    const result = parseScheduledAtField(fd);
    expect(result.kind).toBe("error");
  });

  it("is idempotent across multiple parses of the same value", () => {
    const fd = makeForm({ scheduled_at: "2026-05-20T20:01:00.000Z" });
    const first = parseScheduledAtField(fd);
    const second = parseScheduledAtField(fd);
    expect(first).toEqual(second);
  });
});
