import { describe, expect, it } from "vitest";
import {
  assertScheduleRoundTrip,
  formatUtcForOperatorDebug,
  formatUtcForWorkspace,
  getRelativeDueLabel,
  parseWorkspaceLocalDateTimeToUtc,
} from "./workspace-time";

/**
 * Workspace-time helpers — DB stays UTC, display follows the
 * workspace's IANA zone. Tests pin behavior for the four canonical
 * zones (NY, Prague, UTC, Tokyo) and DST transitions in both
 * hemispheres so the helpers never silently regress to browser-zone
 * behavior.
 */

// ---------------------------------------------------------------------
// parseWorkspaceLocalDateTimeToUtc
// ---------------------------------------------------------------------

describe("parseWorkspaceLocalDateTimeToUtc — basic zones", () => {
  it("America/New_York standard time (EST, -05:00)", () => {
    // 14:33 EST = 19:33 UTC
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-01-15T14:33",
        "America/New_York",
      ),
    ).toBe("2026-01-15T19:33:00.000Z");
  });

  it("America/New_York daylight time (EDT, -04:00)", () => {
    // 14:33 EDT = 18:33 UTC
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-07-15T14:33",
        "America/New_York",
      ),
    ).toBe("2026-07-15T18:33:00.000Z");
  });

  it("Europe/Prague standard time (CET, +01:00)", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-01-15T14:33", "Europe/Prague"),
    ).toBe("2026-01-15T13:33:00.000Z");
  });

  it("Europe/Prague daylight time (CEST, +02:00)", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-07-15T14:33", "Europe/Prague"),
    ).toBe("2026-07-15T12:33:00.000Z");
  });

  it("UTC zone parses as identity", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-05-25T21:33", "UTC"),
    ).toBe("2026-05-25T21:33:00.000Z");
  });

  it("Asia/Tokyo (+09:00, no DST)", () => {
    // 14:33 JST = 05:33 UTC
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-05-25T14:33", "Asia/Tokyo"),
    ).toBe("2026-05-25T05:33:00.000Z");
  });

  it("accepts seconds component", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-05-25T14:33:45",
        "America/New_York",
      ),
    ).toBe("2026-05-25T18:33:45.000Z");
  });

  it("idempotent on TZ-qualified ISO with Z (timezone arg is ignored)", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-05-25T21:33:00.000Z",
        "America/New_York",
      ),
    ).toBe("2026-05-25T21:33:00.000Z");
  });

  it("idempotent on TZ-qualified ISO with explicit offset", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-05-25T17:33:00-04:00",
        "Asia/Tokyo",
      ),
    ).toBe("2026-05-25T21:33:00.000Z");
  });
});

describe("parseWorkspaceLocalDateTimeToUtc — invalid input", () => {
  it("rejects empty string", () => {
    expect(() =>
      parseWorkspaceLocalDateTimeToUtc("", "America/New_York"),
    ).toThrow(/empty/);
  });

  it("rejects whitespace-only", () => {
    expect(() =>
      parseWorkspaceLocalDateTimeToUtc("   ", "America/New_York"),
    ).toThrow(/empty/);
  });

  it("rejects garbage input", () => {
    expect(() =>
      parseWorkspaceLocalDateTimeToUtc("not-a-date", "America/New_York"),
    ).toThrow(/invalid/);
  });

  it("rejects date-only (no time component)", () => {
    expect(() =>
      parseWorkspaceLocalDateTimeToUtc("2026-05-25", "America/New_York"),
    ).toThrow(/invalid/);
  });
});

// ---------------------------------------------------------------------
// DST transitions — regression guards
// ---------------------------------------------------------------------

describe("DST — US spring forward (2026-03-08 02:00 EST → 03:00 EDT)", () => {
  it("01:30 EST (pre-jump) parses as -05:00", () => {
    // 01:30 EST = 06:30 UTC
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-03-08T01:30",
        "America/New_York",
      ),
    ).toBe("2026-03-08T06:30:00.000Z");
  });

  it("03:30 EDT (post-jump) parses as -04:00", () => {
    // 03:30 EDT = 07:30 UTC
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-03-08T03:30",
        "America/New_York",
      ),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("nonexistent 02:30 in the gap does not shift year/month/day", () => {
    // 02:30 EDT-or-EST doesn't exist; parser must still produce a real
    // UTC instant on 2026-03-08, not roll into a previous/next day.
    const iso = parseWorkspaceLocalDateTimeToUtc(
      "2026-03-08T02:30",
      "America/New_York",
    );
    expect(iso.startsWith("2026-03-08")).toBe(true);
  });
});

describe("DST — US fall back (2026-11-01 02:00 EDT → 01:00 EST)", () => {
  it("00:30 EDT parses as -04:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-11-01T00:30",
        "America/New_York",
      ),
    ).toBe("2026-11-01T04:30:00.000Z");
  });

  it("03:30 EST parses as -05:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc(
        "2026-11-01T03:30",
        "America/New_York",
      ),
    ).toBe("2026-11-01T08:30:00.000Z");
  });

  it("ambiguous 01:30 (occurs twice) does not shift year/month/day", () => {
    // 01:30 occurs once during EDT and again during EST.
    // The parser must produce a real UTC instant on Nov 1, not roll
    // to Oct 31 or Nov 2.
    const iso = parseWorkspaceLocalDateTimeToUtc(
      "2026-11-01T01:30",
      "America/New_York",
    );
    expect(iso.startsWith("2026-11-01")).toBe(true);
  });
});

describe("DST — EU spring forward (2026-03-29 02:00 CET → 03:00 CEST)", () => {
  it("01:30 CET parses as +01:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-03-29T01:30", "Europe/Prague"),
    ).toBe("2026-03-29T00:30:00.000Z");
  });

  it("03:30 CEST parses as +02:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-03-29T03:30", "Europe/Prague"),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("nonexistent 02:30 does not shift year/month/day", () => {
    const iso = parseWorkspaceLocalDateTimeToUtc(
      "2026-03-29T02:30",
      "Europe/Prague",
    );
    expect(iso.startsWith("2026-03-29")).toBe(true);
  });
});

describe("DST — EU fall back (2026-10-25 03:00 CEST → 02:00 CET)", () => {
  it("02:30 CEST (first occurrence) parses cleanly", () => {
    const iso = parseWorkspaceLocalDateTimeToUtc(
      "2026-10-25T02:30",
      "Europe/Prague",
    );
    expect(iso.startsWith("2026-10-25")).toBe(true);
  });

  it("04:30 CET parses as +01:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-10-25T04:30", "Europe/Prague"),
    ).toBe("2026-10-25T03:30:00.000Z");
  });
});

describe("DST — Asia/Tokyo never shifts (no DST)", () => {
  it("July 2026 still +09:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-07-15T14:33", "Asia/Tokyo"),
    ).toBe("2026-07-15T05:33:00.000Z");
  });

  it("January 2026 still +09:00", () => {
    expect(
      parseWorkspaceLocalDateTimeToUtc("2026-01-15T14:33", "Asia/Tokyo"),
    ).toBe("2026-01-15T05:33:00.000Z");
  });
});

// ---------------------------------------------------------------------
// formatUtcForWorkspace
// ---------------------------------------------------------------------

describe("formatUtcForWorkspace", () => {
  it("formats UTC ISO in America/New_York", () => {
    const out = formatUtcForWorkspace(
      "2026-05-25T21:33:00.000Z",
      "America/New_York",
    );
    expect(out.local).toMatch(/May 25/);
    expect(out.local).toMatch(/5:33/);
    expect(out.local).toMatch(/PM/);
    expect(out.timezone).toBe("America/New_York");
    expect(out.utc).toBe("2026-05-25 21:33 UTC");
  });

  it("formats UTC ISO in Europe/Prague", () => {
    const out = formatUtcForWorkspace(
      "2026-05-25T19:33:00.000Z",
      "Europe/Prague",
    );
    // 19:33 UTC = 21:33 CEST = 9:33 PM Prague
    expect(out.local).toMatch(/9:33/);
    expect(out.local).toMatch(/PM/);
    expect(out.timezone).toBe("Europe/Prague");
  });

  it("formats UTC ISO in Asia/Tokyo", () => {
    const out = formatUtcForWorkspace(
      "2026-05-25T05:33:00.000Z",
      "Asia/Tokyo",
    );
    // 05:33 UTC = 14:33 JST = 2:33 PM Tokyo
    expect(out.local).toMatch(/2:33/);
    expect(out.local).toMatch(/PM/);
    expect(out.timezone).toBe("Asia/Tokyo");
  });

  it("UTC zone displays the wall clock 1:1", () => {
    const out = formatUtcForWorkspace("2026-05-25T21:33:00.000Z", "UTC");
    expect(out.local).toMatch(/9:33/);
    expect(out.utc).toBe("2026-05-25 21:33 UTC");
  });

  it("gracefully degrades on garbage ISO", () => {
    const out = formatUtcForWorkspace("not-an-iso", "America/New_York");
    expect(out.local).toBe("not-an-iso");
    expect(out.utc).toBe("not-an-iso");
  });
});

describe("formatUtcForOperatorDebug", () => {
  it("always 'YYYY-MM-DD HH:mm UTC'", () => {
    expect(formatUtcForOperatorDebug("2026-05-25T21:33:00.000Z")).toBe(
      "2026-05-25 21:33 UTC",
    );
  });

  it("pads single-digit fields", () => {
    expect(formatUtcForOperatorDebug("2026-01-03T09:05:00.000Z")).toBe(
      "2026-01-03 09:05 UTC",
    );
  });

  it("ignores seconds (minute precision)", () => {
    expect(formatUtcForOperatorDebug("2026-05-25T21:33:45.000Z")).toBe(
      "2026-05-25 21:33 UTC",
    );
  });
});

// ---------------------------------------------------------------------
// getRelativeDueLabel
// ---------------------------------------------------------------------

describe("getRelativeDueLabel — state classification", () => {
  const now = new Date("2026-05-25T18:43:55.000Z");

  it("future > 30s → 'Due in <duration>'", () => {
    const r = getRelativeDueLabel("2026-05-25T21:33:00.000Z", now);
    expect(r.state).toBe("future");
    expect(r.relative).toMatch(/^Due in /);
  });

  it("within 30s of now → 'Due now'", () => {
    const r = getRelativeDueLabel("2026-05-25T18:44:10.000Z", now);
    expect(r.state).toBe("due");
    expect(r.relative).toBe("Due now");
  });

  it("past > 30s → 'Overdue by <duration>'", () => {
    const r = getRelativeDueLabel("2026-05-25T18:37:00.000Z", now);
    expect(r.state).toBe("overdue");
    expect(r.relative).toMatch(/^Overdue by /);
  });

  it("deltaSeconds is signed (positive for future)", () => {
    const r = getRelativeDueLabel("2026-05-25T18:53:55.000Z", now);
    expect(r.deltaSeconds).toBe(600);
  });

  it("deltaSeconds is signed (negative for overdue)", () => {
    const r = getRelativeDueLabel("2026-05-25T18:33:55.000Z", now);
    expect(r.deltaSeconds).toBe(-600);
  });
});

describe("getRelativeDueLabel — duration formatting", () => {
  const now = new Date("2026-05-25T18:43:55.000Z");

  it("hours + minutes", () => {
    const r = getRelativeDueLabel("2026-05-25T21:33:00.000Z", now);
    expect(r.relative).toBe("Due in 2h 49m");
  });

  it("minutes only", () => {
    const r = getRelativeDueLabel("2026-05-25T18:50:00.000Z", now);
    expect(r.relative).toBe("Due in 6m");
  });

  it("days + hours for far future", () => {
    const r = getRelativeDueLabel("2026-05-28T22:43:55.000Z", now);
    expect(r.relative).toBe("Due in 3d 4h");
  });

  it("under a minute → '<1m'", () => {
    const r = getRelativeDueLabel("2026-05-25T18:44:30.000Z", now);
    // 35s in future → outside the 30s 'Due now' band → '<1m'
    expect(r.relative).toBe("Due in <1m");
  });

  it("overdue formatting uses 'Overdue by'", () => {
    const r = getRelativeDueLabel("2026-05-25T16:00:00.000Z", now);
    expect(r.relative).toMatch(/^Overdue by \d+h \d+m$|^Overdue by \d+h$/);
  });

  it("garbage ISO yields a safe placeholder, not throw", () => {
    expect(getRelativeDueLabel("not-an-iso", now).relative).toBe("—");
  });
});

// ---------------------------------------------------------------------
// assertScheduleRoundTrip
// ---------------------------------------------------------------------

describe("assertScheduleRoundTrip", () => {
  it("passes for a valid wall clock in NY", () => {
    expect(() =>
      assertScheduleRoundTrip("2026-05-25T14:33", "America/New_York"),
    ).not.toThrow();
  });

  it("passes for a valid wall clock in Prague", () => {
    expect(() =>
      assertScheduleRoundTrip("2026-05-25T14:33", "Europe/Prague"),
    ).not.toThrow();
  });

  it("throws (DST gap detected) for nonexistent US spring-forward 02:30", () => {
    expect(() =>
      assertScheduleRoundTrip("2026-03-08T02:30", "America/New_York"),
    ).toThrow(/DST gap/);
  });

  it("no-op for TZ-qualified input (caller already pinned the instant)", () => {
    expect(() =>
      assertScheduleRoundTrip(
        "2026-05-25T21:33:00.000Z",
        "America/New_York",
      ),
    ).not.toThrow();
  });
});
