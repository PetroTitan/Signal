import { describe, expect, it } from "vitest";
import {
  buildCalendarGrid,
  parseCalendarAnchor,
  parseCalendarMode,
  type CalendarEvent,
} from "./calendar-grid";

function ev(id: string, scheduledAt: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, scheduledAt, title: id, platform: "bluesky", status: "scheduled", href: `/x/${id}`, ...over };
}

function findDay(grid: ReturnType<typeof buildCalendarGrid>, dateKey: string) {
  for (const week of grid.weeks) for (const d of week) if (d.dateKey === dateKey) return d;
  return null;
}

describe("buildCalendarGrid — month view", () => {
  const anchor = new Date("2026-06-15T12:00:00Z");

  it("renders 6 Mon-aligned weeks covering the focus month", () => {
    const grid = buildCalendarGrid({ events: [], timezone: "UTC", anchor, mode: "month", now: anchor });
    expect(grid.weeks).toHaveLength(6);
    for (const w of grid.weeks) expect(w).toHaveLength(7);
    expect(grid.label).toBe("June 2026");
    // June 2026: 1st is a Monday → first cell is June 1.
    expect(grid.weeks[0][0].dateKey).toBe("2026-06-01");
  });

  it("places an event on its correct workspace-local day", () => {
    const grid = buildCalendarGrid({
      events: [ev("a", "2026-06-15T09:30:00Z")],
      timezone: "UTC",
      anchor,
      mode: "month",
      now: anchor,
    });
    const day = findDay(grid, "2026-06-15");
    expect(day?.events.map((e) => e.id)).toEqual(["a"]);
  });

  it("respects the workspace timezone when bucketing", () => {
    // 03:30 UTC on Jun 16 is 23:30 on Jun 15 in New York (-4 in June).
    const grid = buildCalendarGrid({
      events: [ev("late", "2026-06-16T03:30:00Z")],
      timezone: "America/New_York",
      anchor,
      mode: "month",
      now: anchor,
    });
    expect(findDay(grid, "2026-06-15")?.events.map((e) => e.id)).toEqual(["late"]);
    expect(findDay(grid, "2026-06-16")?.events ?? []).toHaveLength(0);
  });

  it("marks today and the focus month", () => {
    const grid = buildCalendarGrid({ events: [], timezone: "UTC", anchor, mode: "month", now: anchor });
    expect(findDay(grid, "2026-06-15")?.isToday).toBe(true);
    expect(findDay(grid, "2026-06-15")?.inFocusMonth).toBe(true);
    // A trailing cell from May or July is not in focus.
    const may = findDay(grid, "2026-05-31");
    if (may) expect(may.inFocusMonth).toBe(false);
  });

  it("orders multiple events in a day by time", () => {
    const grid = buildCalendarGrid({
      events: [ev("late", "2026-06-10T18:00:00Z"), ev("early", "2026-06-10T08:00:00Z")],
      timezone: "UTC",
      anchor,
      mode: "month",
      now: anchor,
    });
    expect(findDay(grid, "2026-06-10")?.events.map((e) => e.id)).toEqual(["early", "late"]);
  });
});

describe("buildCalendarGrid — week view", () => {
  const anchor = new Date("2026-06-17T12:00:00Z"); // Wednesday

  it("renders one Mon–Sun row containing the anchor", () => {
    const grid = buildCalendarGrid({ events: [], timezone: "UTC", anchor, mode: "week", now: anchor });
    expect(grid.weeks).toHaveLength(1);
    expect(grid.weeks[0][0].dateKey).toBe("2026-06-15"); // Monday
    expect(grid.weeks[0][6].dateKey).toBe("2026-06-21"); // Sunday
  });

  it("prev/next anchors step a full week", () => {
    const grid = buildCalendarGrid({ events: [], timezone: "UTC", anchor, mode: "week", now: anchor });
    expect(grid.prevAnchorIso.slice(0, 10)).toBe("2026-06-10");
    expect(grid.nextAnchorIso.slice(0, 10)).toBe("2026-06-24");
  });
});

describe("parse helpers", () => {
  it("parseCalendarMode defaults to month", () => {
    expect(parseCalendarMode(undefined)).toBe("month");
    expect(parseCalendarMode("week")).toBe("week");
    expect(parseCalendarMode("garbage")).toBe("month");
  });
  it("parseCalendarAnchor falls back to now on bad input", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(parseCalendarAnchor(undefined, now)).toBe(now);
    expect(parseCalendarAnchor("nonsense", now)).toBe(now);
    expect(parseCalendarAnchor("2026-07-01T12:00:00Z", now).toISOString()).toBe(
      "2026-07-01T12:00:00.000Z",
    );
  });
});
