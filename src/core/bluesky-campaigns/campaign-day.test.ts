import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  formatMinutes,
  InvalidTimezoneError,
  isValidTimezone,
  isWithinWindow,
  localClockAt,
  parseMinutes,
  COMMON_TIMEZONES,
} from "./campaign-day";

describe("local calendar date — the daily-run key", () => {
  it("is the date in the campaign timezone, not UTC", () => {
    // 03:00 UTC on the 11th is still the 10th in New York. A quota that
    // reset on the UTC date would reset mid-afternoon for that operator.
    const instant = new Date("2026-09-11T03:00:00Z");
    expect(localClockAt(instant, "UTC").localDate).toBe("2026-09-11");
    expect(localClockAt(instant, "America/New_York").localDate).toBe("2026-09-10");
    expect(localClockAt(instant, "Pacific/Auckland").localDate).toBe("2026-09-11");
  });

  it("formats as YYYY-MM-DD, which sorts and is a Postgres DATE literal", () => {
    const d = localClockAt(new Date("2026-01-05T12:00:00Z"), "Europe/Prague").localDate;
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d).toBe("2026-01-05");
  });

  it("reports minutes from local midnight", () => {
    const c = localClockAt(new Date("2026-09-11T14:35:00Z"), "UTC");
    expect(c.minutesOfDay).toBe(14 * 60 + 35);
  });

  it("treats local midnight as minute 0, not 1440", () => {
    const c = localClockAt(new Date("2026-09-11T00:00:00Z"), "UTC");
    expect(c.minutesOfDay).toBe(0);
    expect(c.localDate).toBe("2026-09-11");
  });

  it("rejects an unknown timezone rather than silently using UTC", () => {
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(() => localClockAt(new Date(), "Mars/Olympus_Mons")).toThrow(
      InvalidTimezoneError,
    );
  });

  it("accepts every timezone offered in the picker", () => {
    for (const tz of COMMON_TIMEZONES) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });
});

describe("DST — spring forward", () => {
  // America/New_York, 2026-03-08: 02:00 local does not exist.
  const TZ = "America/New_York";

  it("the skipped hour never matches a window inside it", () => {
    // A campaign configured for 02:00–03:00 would never run that day if
    // we reconstructed a local timestamp; comparing on the instant
    // simply finds no match, which is the honest answer.
    const window = { startMinute: 120, endMinute: 180 }; // 02:00–03:00
    for (let m = 0; m < 24 * 60; m += 5) {
      const instant = new Date(Date.UTC(2026, 2, 8, 0, 0) + m * 60_000);
      const clock = localClockAt(instant, TZ);
      if (clock.localDate !== "2026-03-08") continue;
      // Nothing on this local date lands between 02:00 and 03:00.
      expect(clock.minutesOfDay < 120 || clock.minutesOfDay >= 180).toBe(true);
      expect(isWithinWindow(instant, TZ, window)).toBe(false);
    }
  });

  it("the local date still advances exactly once across the transition", () => {
    const before = localClockAt(new Date("2026-03-08T06:30:00Z"), TZ);
    const after = localClockAt(new Date("2026-03-08T07:30:00Z"), TZ);
    expect(before.localDate).toBe("2026-03-08");
    expect(after.localDate).toBe("2026-03-08");
    // 01:30 EST → 03:30 EDT: the clock jumped, the date did not.
    expect(before.minutesOfDay).toBe(90);
    expect(after.minutesOfDay).toBe(210);
  });

  it("a normal window still opens on a spring-forward day", () => {
    const window = { startMinute: 540, endMinute: 1200 }; // 09:00–20:00
    expect(isWithinWindow(new Date("2026-03-08T14:00:00Z"), TZ, window)).toBe(true);
  });
});

describe("DST — fall back", () => {
  const TZ = "America/New_York";

  it("the repeated hour occurs twice but on ONE local date", () => {
    // 2026-11-01: 01:30 local happens at 05:30Z (EDT) and 06:30Z (EST).
    const first = localClockAt(new Date("2026-11-01T05:30:00Z"), TZ);
    const second = localClockAt(new Date("2026-11-01T06:30:00Z"), TZ);
    expect(first.minutesOfDay).toBe(90);
    expect(second.minutesOfDay).toBe(90);
    // Same local DATE — so the unique index on (campaign, local_date)
    // collapses both passes into one daily run.
    expect(first.localDate).toBe("2026-11-01");
    expect(second.localDate).toBe("2026-11-01");
    expect(first.timeZoneName).not.toBe(second.timeZoneName);
  });

  it("a window inside the repeated hour is entered twice, same day", () => {
    const window = { startMinute: 60, endMinute: 120 }; // 01:00–02:00
    expect(isWithinWindow(new Date("2026-11-01T05:30:00Z"), TZ, window)).toBe(true);
    expect(isWithinWindow(new Date("2026-11-01T06:30:00Z"), TZ, window)).toBe(true);
  });

  it("a fall-back day has 25 local hours without producing two dates", () => {
    const dates = new Set<string>();
    for (let h = 0; h < 30; h += 1) {
      const instant = new Date(Date.UTC(2026, 10, 1, 4, 0) + h * 3_600_000);
      dates.add(localClockAt(instant, TZ).localDate);
    }
    // 2026-11-01 and 2026-11-02 only.
    expect([...dates].sort()).toEqual(["2026-11-01", "2026-11-02"]);
  });
});

describe("execution window", () => {
  const TZ = "Europe/Prague";
  const window = { startMinute: 540, endMinute: 1200 }; // 09:00–20:00

  it("is half-open: the end minute is excluded", () => {
    // 20:00 Prague in September is 18:00Z.
    expect(isWithinWindow(new Date("2026-09-11T17:59:00Z"), TZ, window)).toBe(true);
    expect(isWithinWindow(new Date("2026-09-11T18:00:00Z"), TZ, window)).toBe(false);
  });

  it("includes the start minute", () => {
    // 09:00 Prague = 07:00Z in September.
    expect(isWithinWindow(new Date("2026-09-11T07:00:00Z"), TZ, window)).toBe(true);
    expect(isWithinWindow(new Date("2026-09-11T06:59:00Z"), TZ, window)).toBe(false);
  });

  it("adjacent windows do not overlap at their shared edge", () => {
    const morning = { startMinute: 540, endMinute: 720 };
    const afternoon = { startMinute: 720, endMinute: 1080 };
    const noon = new Date("2026-09-11T10:00:00Z"); // 12:00 Prague
    expect(isWithinWindow(noon, TZ, morning)).toBe(false);
    expect(isWithinWindow(noon, TZ, afternoon)).toBe(true);
  });
});

describe("computeNextRunAt", () => {
  const TZ = "America/New_York";
  const window = { startMinute: 540, endMinute: 1200 };

  it("is always in the future", () => {
    const from = new Date("2026-09-11T12:00:00Z");
    expect(computeNextRunAt({ from, timezone: TZ, window }).getTime()).toBeGreaterThan(
      from.getTime(),
    );
  });

  it("lands inside the window", () => {
    // 23:00Z = 19:00 New York, inside 09:00-20:00 — next slot is soon.
    const next = computeNextRunAt({
      from: new Date("2026-09-11T23:00:00Z"),
      timezone: TZ,
      window,
    });
    expect(isWithinWindow(next, TZ, window)).toBe(true);
  });

  it("skips forward to tomorrow's window when today's has closed", () => {
    // 02:00Z on the 12th = 22:00 on the 11th in New York, past the
    // window. The next slot must be the 12th's morning.
    const next = computeNextRunAt({
      from: new Date("2026-09-12T02:00:00Z"),
      timezone: TZ,
      window,
    });
    expect(localClockAt(next, TZ).localDate).toBe("2026-09-12");
    expect(isWithinWindow(next, TZ, window)).toBe(true);
  });

  it("respects a start date in the future", () => {
    const next = computeNextRunAt({
      from: new Date("2026-09-11T12:00:00Z"),
      timezone: TZ,
      window,
      notBeforeLocalDate: "2026-09-12",
    });
    expect(localClockAt(next, TZ).localDate >= "2026-09-12").toBe(true);
  });

  it("finds a window on a spring-forward day", () => {
    const next = computeNextRunAt({
      from: new Date("2026-03-08T02:00:00Z"),
      timezone: TZ,
      window,
    });
    expect(isWithinWindow(next, TZ, window)).toBe(true);
  });
});

describe("minute formatting", () => {
  it("round-trips", () => {
    for (const m of [0, 1, 59, 60, 540, 1200, 1439]) {
      expect(parseMinutes(formatMinutes(m))).toBe(m);
    }
  });

  it("formats with a leading zero", () => {
    expect(formatMinutes(0)).toBe("00:00");
    expect(formatMinutes(540)).toBe("09:00");
    expect(formatMinutes(1200)).toBe("20:00");
  });

  it("rejects malformed input rather than coercing", () => {
    for (const v of ["", "9", "25:00", "09:60", "abc", "09-00"]) {
      expect(parseMinutes(v), v).toBeNull();
    }
  });
});
