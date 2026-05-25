import { describe, expect, it } from "vitest";
import {
  datetimeLocalToIso,
  toDatetimeLocalString,
} from "./schedule-presets";

describe("toDatetimeLocalString", () => {
  it("formats a Date with zero-padded minute precision", () => {
    const d = new Date();
    d.setFullYear(2026, 4, 20); // May = 4 (0-indexed)
    d.setHours(16, 1, 0, 0);
    expect(toDatetimeLocalString(d)).toBe("2026-05-20T16:01");
  });

  it("zero-pads single-digit months/days/hours/minutes", () => {
    const d = new Date();
    d.setFullYear(2026, 0, 3); // Jan = 0
    d.setHours(9, 5, 0, 0);
    expect(toDatetimeLocalString(d)).toBe("2026-01-03T09:05");
  });
});

describe("datetimeLocalToIso", () => {
  it("converts a bare datetime-local to an ISO with TZ suffix", () => {
    const iso = datetimeLocalToIso("2026-05-20T16:01");
    // Must round-trip to a Date with the same wall-clock time in the
    // caller's runtime zone.
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(4);
    expect(back.getDate()).toBe(20);
    expect(back.getHours()).toBe(16);
    expect(back.getMinutes()).toBe(1);
  });

  it("returns the same wall-clock minute when round-tripped through toDatetimeLocalString", () => {
    const original = "2026-05-20T16:01";
    const iso = datetimeLocalToIso(original);
    const rt = toDatetimeLocalString(new Date(iso));
    expect(rt).toBe(original);
  });

  it("is idempotent for a multi-pass round-trip (no schedule drift)", () => {
    let v = "2026-05-20T16:01";
    for (let i = 0; i < 5; i++) {
      const iso = datetimeLocalToIso(v);
      v = toDatetimeLocalString(new Date(iso));
    }
    expect(v).toBe("2026-05-20T16:01");
  });

  it("accepts an already-ISO string with Z suffix and normalizes it", () => {
    const iso = datetimeLocalToIso("2026-05-20T20:01:00.000Z");
    expect(iso).toBe("2026-05-20T20:01:00.000Z");
  });

  it("accepts an already-ISO string with +HH:MM offset", () => {
    const iso = datetimeLocalToIso("2026-05-20T16:01:00-04:00");
    // 16:01 EDT == 20:01 UTC
    expect(iso).toBe("2026-05-20T20:01:00.000Z");
  });

  it("throws on empty input", () => {
    expect(() => datetimeLocalToIso("")).toThrow();
    expect(() => datetimeLocalToIso("   ")).toThrow();
  });

  it("throws on invalid input", () => {
    expect(() => datetimeLocalToIso("not-a-date")).toThrow();
  });
});
