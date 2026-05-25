import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setScheduleEventSink,
  emitAutosaveScheduleMutationAttempt,
  emitRewriteScheduleMutationAttempt,
  emitScheduleChecksumMismatch,
  emitScheduleParseInvalid,
  emitScheduleRoundtripDelta,
  emitScheduleSaveRejected,
  emitScheduleSaveSuccess,
  emitScheduleSourceChange,
  type ScheduleEventName,
  type ScheduleEventPayload,
} from "./schedule-events";

interface CapturedEvent {
  name: ScheduleEventName;
  payload: ScheduleEventPayload;
}

function withSink<T>(run: (captured: CapturedEvent[]) => T): T {
  const captured: CapturedEvent[] = [];
  __setScheduleEventSink((name, payload) => {
    captured.push({ name, payload });
  });
  try {
    return run(captured);
  } finally {
    __setScheduleEventSink(null);
  }
}

afterEach(() => {
  __setScheduleEventSink(null);
});

describe("schedule-events sink override", () => {
  it("captures all emitted events synchronously", () => {
    withSink((captured) => {
      emitScheduleSaveSuccess({
        itemId: "i1",
        source: "preset",
        reason: "preset",
        checksum: "abc",
      });
      expect(captured).toHaveLength(1);
      expect(captured[0].name).toBe("schedule_save_success");
      expect(captured[0].payload.itemId).toBe("i1");
      expect(captured[0].payload.source).toBe("preset");
      expect(captured[0].payload.mutationBlocked).toBe(false);
    });
  });

  it("falls back to default sink after override is cleared", () => {
    const log = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logProd = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      emitScheduleSaveSuccess({
        itemId: "i1",
        source: "manual",
        reason: "input",
        checksum: "x",
      });
      // Either console.debug or console.log gets called (depending on NODE_ENV).
      const total = log.mock.calls.length + logProd.mock.calls.length;
      expect(total).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      logProd.mockRestore();
    }
  });
});

describe("schedule-events payload shape", () => {
  it("always includes a UTC ISO timestamp and the resolved timezone", () => {
    withSink((captured) => {
      emitScheduleSaveSuccess({ itemId: "i", source: "manual", reason: "input" });
      const p = captured[0].payload;
      expect(p.at).toMatch(/T.*Z$/);
      // timezone may be null on stripped runtimes; either way it's
      // present as a key.
      expect("timezone" in p).toBe(true);
    });
  });

  it("never leaks body / title / token fields", () => {
    withSink((captured) => {
      emitScheduleSaveRejected({
        itemId: "i",
        source: "manual",
        reason: "input",
        detail: "rejected — invalid",
      });
      const p = captured[0].payload;
      expect(p).not.toHaveProperty("body");
      expect(p).not.toHaveProperty("title");
      expect(p).not.toHaveProperty("token");
      expect(p).not.toHaveProperty("authorization");
    });
  });

  it("marks mutation-blocked events with mutationBlocked=true", () => {
    withSink((captured) => {
      emitRewriteScheduleMutationAttempt({
        itemId: "i",
        source: "manual",
        reason: "rewrite",
      });
      emitAutosaveScheduleMutationAttempt({
        itemId: "i",
        source: "manual",
        reason: "body_autosave",
      });
      emitScheduleParseInvalid({
        itemId: "i",
        source: null,
        reason: null,
        detail: "bare local",
      });
      emitScheduleChecksumMismatch({
        itemId: "i",
        source: "manual",
        reason: "input",
        checksum: "abc",
        detail: "mismatch",
      });
      for (const e of captured) {
        expect(e.payload.mutationBlocked).toBe(true);
      }
    });
  });

  it("emits drift in milliseconds on roundtrip-delta events", () => {
    withSink((captured) => {
      emitScheduleRoundtripDelta({
        itemId: "i",
        source: "manual",
        reason: "input",
        driftMs: 14_400_000,
      });
      expect(captured[0].payload.driftMs).toBe(14_400_000);
    });
  });

  it("emits source-change with detail", () => {
    withSink((captured) => {
      emitScheduleSourceChange({
        itemId: "i",
        source: "mcp",
        reason: "mcp",
        detail: "manual → mcp",
      });
      expect(captured[0].payload.detail).toContain("→");
    });
  });
});
