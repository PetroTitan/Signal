import { describe, expect, it } from "vitest";
import {
  formatScheduleDebugUtc,
  formatScheduleDisplay,
} from "./format-schedule-display";

const NOW = new Date("2026-05-25T18:43:55.000Z");

describe("formatScheduleDisplay — no schedule", () => {
  it("nothing scheduled → null fields, source=none, no warning", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: null },
      workspaceTimezone: "America/New_York",
      serverNow: NOW,
    });
    expect(r.effectiveScheduledAt).toBe(null);
    expect(r.local).toBe(null);
    expect(r.utc).toBe(null);
    expect(r.relative).toBe(null);
    expect(r.dueState).toBe(null);
    expect(r.dueInSeconds).toBe(null);
    expect(r.source).toBe("none");
    expect(r.sourceLabel).toBe("No schedule");
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceWarning).toBe(null);
    expect(r.timezone).toBe("America/New_York"); // present even on null
  });
});

describe("formatScheduleDisplay — editorial only (no execution_item)", () => {
  it("plan_item only → source=weekly_plan_item, local + utc + due", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: "2026-05-25T21:33:00.000Z" },
      workspaceTimezone: "America/New_York",
      serverNow: NOW,
    });
    expect(r.effectiveScheduledAt).toBe("2026-05-25T21:33:00.000Z");
    expect(r.source).toBe("weekly_plan_item");
    expect(r.sourceLabel).toBe("Planning time only");
    expect(r.local).toMatch(/5:33/); // 21:33 UTC = 17:33 EDT = 5:33 PM
    expect(r.local).toMatch(/PM/);
    expect(r.utc).toBe("2026-05-25 21:33 UTC");
    expect(r.timezone).toBe("America/New_York");
    expect(r.relative).toBe("Due in 2h 49m");
    expect(r.dueState).toBe("future");
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceWarning).toBe(null);
  });
});

describe("formatScheduleDisplay — active execution_item", () => {
  it("active exec → source=execution_item, time follows exec", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: "2026-05-25T19:44:00.000Z" }, // editorial time
      executionItem: {
        status: "scheduled",
        scheduledAt: "2026-05-25T21:33:00.000Z",
      },
      workspaceTimezone: "America/New_York",
      serverNow: NOW,
    });
    expect(r.effectiveScheduledAt).toBe("2026-05-25T21:33:00.000Z");
    expect(r.source).toBe("execution_item");
    expect(r.sourceLabel).toBe("Publish trigger: execution item");
    expect(r.local).toMatch(/5:33/);
    expect(r.relative).toBe("Due in 2h 49m");
    expect(r.isDiverged).toBe(true);
    expect(r.divergenceWarning).toMatch(/differ/i);
  });

  it("active exec with matching editorial → no divergence warning", () => {
    const sameIso = "2026-05-25T21:33:00.000Z";
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: sameIso },
      executionItem: { status: "scheduled", scheduledAt: sameIso },
      workspaceTimezone: "America/New_York",
      serverNow: NOW,
    });
    expect(r.source).toBe("execution_item");
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceWarning).toBe(null);
  });

  it("terminal exec falls back to editorial; no divergence flagged", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: "2026-05-25T19:44:00.000Z" },
      executionItem: {
        status: "blocked",
        scheduledAt: "2026-05-25T15:30:00.000Z",
      },
      workspaceTimezone: "America/New_York",
      serverNow: NOW,
    });
    expect(r.source).toBe("weekly_plan_item");
    expect(r.effectiveScheduledAt).toBe("2026-05-25T19:44:00.000Z");
    expect(r.isDiverged).toBe(false);
  });
});

describe("formatScheduleDisplay — due states", () => {
  const SAME_ISO = "2026-05-25T21:33:00.000Z";

  it("future → dueState=future, dueInSeconds positive", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: SAME_ISO },
      workspaceTimezone: "UTC",
      serverNow: new Date("2026-05-25T18:43:55.000Z"),
    });
    expect(r.dueState).toBe("future");
    expect(r.dueInSeconds).toBeGreaterThan(0);
  });

  it("due now → dueState=due", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: SAME_ISO },
      workspaceTimezone: "UTC",
      serverNow: new Date(SAME_ISO),
    });
    expect(r.dueState).toBe("due");
    expect(r.relative).toBe("Due now");
  });

  it("overdue → dueState=overdue, dueInSeconds negative", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: SAME_ISO },
      workspaceTimezone: "UTC",
      serverNow: new Date("2026-05-25T22:00:00.000Z"),
    });
    expect(r.dueState).toBe("overdue");
    expect(r.dueInSeconds).toBeLessThan(0);
  });
});

describe("formatScheduleDisplay — zone consistency", () => {
  const ISO = "2026-05-25T21:33:00.000Z";

  it("UTC zone shows wall clock 1:1", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: ISO },
      workspaceTimezone: "UTC",
      serverNow: NOW,
    });
    expect(r.local).toMatch(/9:33/);
    expect(r.utc).toBe("2026-05-25 21:33 UTC");
  });

  it("Europe/Prague displays +02:00 wall clock", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: "2026-05-25T19:33:00.000Z" },
      workspaceTimezone: "Europe/Prague",
      serverNow: NOW,
    });
    // CEST = +02:00 → 21:33 local
    expect(r.local).toMatch(/9:33/);
    expect(r.timezone).toBe("Europe/Prague");
  });

  it("Asia/Tokyo displays +09:00 wall clock", () => {
    const r = formatScheduleDisplay({
      planItem: { scheduledAt: "2026-05-25T05:33:00.000Z" },
      workspaceTimezone: "Asia/Tokyo",
      serverNow: NOW,
    });
    expect(r.local).toMatch(/2:33/);
    expect(r.local).toMatch(/PM/);
  });
});

describe("formatScheduleDebugUtc", () => {
  it("null → null", () => {
    expect(formatScheduleDebugUtc(null)).toBe(null);
  });

  it("normalizes a UTC ISO to operator-debug shape", () => {
    expect(formatScheduleDebugUtc("2026-05-25T21:33:00.000Z")).toBe(
      "2026-05-25 21:33 UTC",
    );
  });
});
