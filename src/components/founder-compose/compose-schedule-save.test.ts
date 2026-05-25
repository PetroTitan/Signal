import { describe, expect, it, vi } from "vitest";
import {
  assertScheduleReason,
  buildScheduleSavePayload,
  initialScheduleState,
  touchByClear,
  touchByInput,
  touchByPreset,
} from "./compose-schedule-save";

describe("initialScheduleState", () => {
  it("returns empty input when no ISO is supplied", () => {
    const s = initialScheduleState(null);
    expect(s).toEqual({ inputValue: "", initialIso: null, touched: false });
  });

  it("seeds the input from the row's stored ISO", () => {
    // Pick a UTC ISO; the helper renders local-time digits, so we
    // verify by parsing back, not by string match.
    const iso = "2026-05-20T20:01:00.000Z";
    const s = initialScheduleState(iso);
    expect(s.initialIso).toBe(iso);
    expect(s.inputValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(s.touched).toBe(false);
  });

  it("never marks initial state as touched even with a value", () => {
    const s = initialScheduleState("2026-05-20T20:01:00.000Z");
    expect(s.touched).toBe(false);
  });
});

describe("touch functions", () => {
  it("touchByInput sets touched=true and the new input value", () => {
    const s = initialScheduleState(null);
    const next = touchByInput(s, "2026-05-20T16:01");
    expect(next.touched).toBe(true);
    expect(next.inputValue).toBe("2026-05-20T16:01");
  });

  it("touchByPreset sets touched=true and the new input value", () => {
    const s = initialScheduleState(null);
    const next = touchByPreset(s, "2026-05-21T09:00");
    expect(next.touched).toBe(true);
    expect(next.inputValue).toBe("2026-05-21T09:00");
  });

  it("touchByClear sets touched=true and empties the input", () => {
    const s = initialScheduleState("2026-05-20T20:01:00.000Z");
    const next = touchByClear(s);
    expect(next.touched).toBe(true);
    expect(next.inputValue).toBe("");
  });
});

describe("buildScheduleSavePayload", () => {
  it("returns null when the operator hasn't touched", () => {
    const s = initialScheduleState("2026-05-20T20:01:00.000Z");
    expect(buildScheduleSavePayload(s, "item-1", "input")).toBe(null);
  });

  it("returns null when itemId is missing", () => {
    const s = touchByInput(initialScheduleState(null), "2026-05-20T16:01");
    expect(buildScheduleSavePayload(s, null, "input")).toBe(null);
  });

  it("produces a clear payload when input is empty + touched", () => {
    const s = touchByClear(initialScheduleState("2026-05-20T20:01:00.000Z"));
    const payload = buildScheduleSavePayload(s, "item-1", "clear");
    expect(payload).toEqual({
      itemId: "item-1",
      isoOrEmpty: "",
      reason: "clear",
    });
  });

  it("produces an ISO payload when input is non-empty + touched", () => {
    const s = touchByInput(initialScheduleState(null), "2026-05-20T16:01");
    const payload = buildScheduleSavePayload(s, "item-1", "input");
    expect(payload?.itemId).toBe("item-1");
    expect(payload?.reason).toBe("input");
    expect(payload?.isoOrEmpty).toMatch(
      /^2026-05-20T\d{2}:01:00\.000Z$/,
    );
  });

  it("throws on a malformed datetime-local value", () => {
    const s = touchByInput(initialScheduleState(null), "not-a-date");
    expect(() => buildScheduleSavePayload(s, "item-1", "input")).toThrow();
  });
});

describe("assertScheduleReason", () => {
  it("accepts preset, input, clear", () => {
    expect(() => assertScheduleReason("preset")).not.toThrow();
    expect(() => assertScheduleReason("input")).not.toThrow();
    expect(() => assertScheduleReason("clear")).not.toThrow();
  });

  it("rejects undefined / null / unknown reasons and logs a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => assertScheduleReason(undefined)).toThrow();
      expect(() => assertScheduleReason(null)).toThrow();
      expect(() =>
        assertScheduleReason("body" as unknown as "input"),
      ).toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
