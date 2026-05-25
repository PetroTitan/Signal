import { describe, expect, it } from "vitest";
import type { ExecutionItem } from "@/core/execution-engine";
import {
  RESYNC_ELIGIBLE_STATUSES,
  classifyResyncTarget,
  describeSkip,
} from "./resync-execution-item-schedule";

/**
 * Regression guards for the schedule-resync classifier.
 *
 * Pre-fix the operator could change weekly_plan_items.scheduled_at
 * but the corresponding execution_items.scheduled_at stayed frozen,
 * so the scheduler kept using the old time. These tests pin the
 * classifier's decision table so a future cleanup can't reopen the
 * silent divergence.
 */

function ei(
  status: ExecutionItem["status"],
  scheduledAt: string | null = "2026-06-01T12:00:00.000Z",
): Pick<ExecutionItem, "status" | "scheduledAt"> {
  return { status, scheduledAt };
}

describe("RESYNC_ELIGIBLE_STATUSES", () => {
  it("is exactly { pending_authorization, authorized, scheduled }", () => {
    expect(RESYNC_ELIGIBLE_STATUSES.size).toBe(3);
    expect(RESYNC_ELIGIBLE_STATUSES.has("pending_authorization")).toBe(true);
    expect(RESYNC_ELIGIBLE_STATUSES.has("authorized")).toBe(true);
    expect(RESYNC_ELIGIBLE_STATUSES.has("scheduled")).toBe(true);
  });

  it("excludes runner-claimed + terminal + retry-required statuses", () => {
    expect(RESYNC_ELIGIBLE_STATUSES.has("ready")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("ready_for_manual_publish")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("running")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("paused")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("failed")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("completed")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("blocked")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("cancelled")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("skipped")).toBe(false);
    expect(RESYNC_ELIGIBLE_STATUSES.has("backlogged")).toBe(false);
  });
});

describe("classifyResyncTarget — eligible statuses", () => {
  const NEXT = "2026-06-02T18:00:00.000Z";

  it("pending_authorization with new ISO → resync", () => {
    expect(
      classifyResyncTarget(ei("pending_authorization"), NEXT),
    ).toEqual({
      action: "resync",
      previousScheduledAt: "2026-06-01T12:00:00.000Z",
      nextScheduledAt: NEXT,
    });
  });

  it("authorized with new ISO → resync", () => {
    expect(classifyResyncTarget(ei("authorized"), NEXT)).toEqual({
      action: "resync",
      previousScheduledAt: "2026-06-01T12:00:00.000Z",
      nextScheduledAt: NEXT,
    });
  });

  it("scheduled with new ISO → resync (the production case)", () => {
    expect(classifyResyncTarget(ei("scheduled"), NEXT)).toEqual({
      action: "resync",
      previousScheduledAt: "2026-06-01T12:00:00.000Z",
      nextScheduledAt: NEXT,
    });
  });

  it("scheduled with same ISO → skip_no_change", () => {
    const current = "2026-06-01T12:00:00.000Z";
    expect(classifyResyncTarget(ei("scheduled", current), current)).toEqual({
      action: "skip_no_change",
    });
  });

  it("scheduled when previous scheduled_at is null → resync with previous=null", () => {
    expect(classifyResyncTarget(ei("scheduled", null), NEXT)).toEqual({
      action: "resync",
      previousScheduledAt: null,
      nextScheduledAt: NEXT,
    });
  });
});

describe("classifyResyncTarget — runner / retry refusals", () => {
  const NEXT = "2026-06-02T18:00:00.000Z";

  it("running → skip_running (publish in flight)", () => {
    expect(classifyResyncTarget(ei("running"), NEXT)).toEqual({
      action: "skip_running",
    });
  });

  it("ready → skip_ready (claimed by current tick)", () => {
    expect(classifyResyncTarget(ei("ready"), NEXT)).toEqual({
      action: "skip_ready",
    });
  });

  it("ready_for_manual_publish → skip_ready", () => {
    expect(classifyResyncTarget(ei("ready_for_manual_publish"), NEXT)).toEqual({
      action: "skip_ready",
    });
  });

  it("paused → skip_paused (operator must use Schedule retry)", () => {
    expect(classifyResyncTarget(ei("paused"), NEXT)).toEqual({
      action: "skip_paused",
    });
  });

  it("failed → skip_failed (retry path creates fresh row)", () => {
    expect(classifyResyncTarget(ei("failed"), NEXT)).toEqual({
      action: "skip_failed",
    });
  });
});

describe("classifyResyncTarget — terminal refusals (history is immutable)", () => {
  const NEXT = "2026-06-02T18:00:00.000Z";
  const TERMINAL = [
    "completed",
    "cancelled",
    "skipped",
    "blocked",
    "backlogged",
  ] as const;

  for (const status of TERMINAL) {
    it(`${status} → skip_terminal`, () => {
      expect(classifyResyncTarget(ei(status), NEXT)).toEqual({
        action: "skip_terminal",
        status,
      });
    });
  }
});

describe("classifyResyncTarget — null next ISO is treated as clear, not reschedule", () => {
  it("eligible status + null ISO → skip_clear (unschedule path)", () => {
    expect(classifyResyncTarget(ei("scheduled"), null)).toEqual({
      action: "skip_clear",
    });
  });

  it("running + null ISO → skip_clear (clear check runs before status)", () => {
    expect(classifyResyncTarget(ei("running"), null)).toEqual({
      action: "skip_clear",
    });
  });

  it("terminal + null ISO → skip_clear", () => {
    expect(classifyResyncTarget(ei("completed"), null)).toEqual({
      action: "skip_clear",
    });
  });
});

describe("describeSkip — operator-facing copy", () => {
  it("returns null for resync / skip_no_change / skip_clear (no operator message)", () => {
    expect(
      describeSkip({
        action: "resync",
        previousScheduledAt: null,
        nextScheduledAt: "x",
      }),
    ).toBeNull();
    expect(describeSkip({ action: "skip_no_change" })).toBeNull();
    expect(describeSkip({ action: "skip_clear" })).toBeNull();
  });

  it("returns a non-empty string for each blocking skip", () => {
    expect(describeSkip({ action: "skip_running" })).toMatch(/in flight/i);
    expect(describeSkip({ action: "skip_ready" })).toMatch(/claimed/i);
    expect(describeSkip({ action: "skip_paused" })).toMatch(/Schedule retry/);
    expect(describeSkip({ action: "skip_failed" })).toMatch(/Schedule retry/);
    expect(
      describeSkip({ action: "skip_terminal", status: "blocked" }),
    ).toMatch(/blocked/);
  });
});
