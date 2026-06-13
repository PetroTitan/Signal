import { describe, expect, it } from "vitest";
import { computeSchedulerHealth, nextTickBoundary } from "./scheduler-health";

describe("nextTickBoundary", () => {
  it("rounds up to the next 5-minute boundary", () => {
    expect(nextTickBoundary(new Date("2026-06-13T12:03:10Z"), 5).toISOString()).toBe(
      "2026-06-13T12:05:00.000Z",
    );
  });
  it("jumps a full interval when exactly on a boundary", () => {
    expect(nextTickBoundary(new Date("2026-06-13T12:05:00Z"), 5).toISOString()).toBe(
      "2026-06-13T12:10:00.000Z",
    );
  });
});

describe("computeSchedulerHealth", () => {
  const now = new Date("2026-06-13T12:02:00Z");
  const base = {
    scheduledCount: 0,
    retryQueueCount: 0,
    runningNowCount: 0,
    lastObservedPublishAtIso: null,
    now,
  };

  it("idle when nothing scheduled and nothing running", () => {
    const h = computeSchedulerHealth(base);
    expect(h.state).toBe("idle");
    expect(h.nextExpectedTickIso).toBe("2026-06-13T12:05:00.000Z");
    expect(h.minutesToNextTick).toBe(3);
  });

  it("running when an item is mid-publish", () => {
    expect(computeSchedulerHealth({ ...base, runningNowCount: 1, scheduledCount: 4 }).state).toBe(
      "running",
    );
  });

  it("active with a modest queue", () => {
    expect(computeSchedulerHealth({ ...base, scheduledCount: 4 }).state).toBe("active");
  });

  it("backlogged when the queue exceeds one tick batch", () => {
    expect(computeSchedulerHealth({ ...base, scheduledCount: 25 }).state).toBe(
      "backlogged",
    );
  });

  it("summary reflects real counts incl. retry queue", () => {
    const h = computeSchedulerHealth({
      ...base,
      scheduledCount: 6,
      retryQueueCount: 2,
    });
    expect(h.summary).toMatch(/6 scheduled \(2 retrying\)/);
    expect(h.summary).toMatch(/next run in ~3m/);
  });

  it("passes through the proxy last-publish timestamp untouched", () => {
    const h = computeSchedulerHealth({
      ...base,
      lastObservedPublishAtIso: "2026-06-13T11:55:00Z",
    });
    expect(h.lastObservedPublishAtIso).toBe("2026-06-13T11:55:00Z");
  });
});
