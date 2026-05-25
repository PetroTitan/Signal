import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setScheduleEventSink,
  type ScheduleEventName,
  type ScheduleEventPayload,
  type ScheduleSource,
} from "@/core/observability/schedule-events";
import {
  assertScheduleUnchanged,
  scheduleChecksum,
} from "./schedule-checksum";

/**
 * Source-propagation + mutation-rejection tests.
 *
 * These tests verify the contract that the audit-trail source field
 * survives:
 *   - serialization
 *   - reloads
 *   - rewrite operations
 *
 * They DO NOT call the server action directly (which would require
 * a full Supabase stack). Instead they verify the pure helpers that
 * underpin propagation: the checksum input model and the mutation
 * assertion utility.
 */

interface CapturedEvent {
  name: ScheduleEventName;
  payload: ScheduleEventPayload;
}

let captured: CapturedEvent[] = [];

beforeEach(() => {
  captured = [];
  __setScheduleEventSink((name, payload) => captured.push({ name, payload }));
});

afterEach(() => {
  __setScheduleEventSink(null);
});

describe("source field survives serialization", () => {
  it.each<ScheduleSource>([
    "manual",
    "preset",
    "mcp",
    "api",
    "migration",
    "recovery",
  ])("checksum is stable for source=%s across re-serialization", (source) => {
    const input = {
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source,
    };
    const c1 = scheduleChecksum(input);
    const round = JSON.parse(JSON.stringify(input));
    const c2 = scheduleChecksum(round);
    expect(c1).toBe(c2);
  });

  it("differs across sources (audit detects source changes)", () => {
    const baseInput = {
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
    };
    const checksums = new Map<ScheduleSource, string>();
    const sources: ScheduleSource[] = [
      "manual",
      "preset",
      "mcp",
      "api",
      "migration",
      "recovery",
    ];
    for (const s of sources) {
      checksums.set(s, scheduleChecksum({ ...baseInput, source: s }));
    }
    const unique = new Set(checksums.values());
    expect(unique.size).toBe(sources.length);
  });
});

describe("mutation rejection — assertScheduleUnchanged", () => {
  it("returns ok when only operator changes touched the schedule", () => {
    const before = {
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual" as const,
    };
    const after = { ...before };
    const r = assertScheduleUnchanged(before, after);
    expect(r.ok).toBe(true);
  });

  it("rejects when ISO drifts (e.g., autosave loop)", () => {
    const before = {
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual" as const,
    };
    const after = {
      ...before,
      iso: "2026-05-20T16:01:00.000Z", // 4h backward shift
    };
    const r = assertScheduleUnchanged(before, after);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("iso");
  });

  it("rejects when source is silently overwritten", () => {
    const before = {
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "mcp" as const,
    };
    const after = { ...before, source: "manual" as const };
    const r = assertScheduleUnchanged(before, after);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("source");
  });
});

describe("checksum is included in audit log entries (synthetic)", () => {
  // Synthetic: we exercise the emitter directly to verify the
  // observability layer carries the checksum through to the payload.
  it("schedule_save_success carries the checksum and source", async () => {
    const { emitScheduleSaveSuccess } = await import(
      "@/core/observability/schedule-events"
    );
    emitScheduleSaveSuccess({
      itemId: "i",
      source: "preset",
      reason: "preset",
      checksum: "deadbeef",
    });
    expect(captured).toHaveLength(1);
    const p = captured[0].payload;
    expect(p.source).toBe("preset");
    expect(p.checksum).toBe("deadbeef");
  });

  it("rewrite_schedule_mutation_attempt carries mutationBlocked=true", async () => {
    const { emitRewriteScheduleMutationAttempt } = await import(
      "@/core/observability/schedule-events"
    );
    emitRewriteScheduleMutationAttempt({
      itemId: "i",
      source: "manual",
      reason: "rewrite",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].payload.mutationBlocked).toBe(true);
  });
});
