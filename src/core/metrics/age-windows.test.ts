import { describe, expect, it } from "vitest";
import {
  AGE_WINDOWS,
  ageHours,
  classifyAgeWindow,
  comparableInWindow,
  readingForWindow,
  resolveAge,
  snapshotSchedule,
  windowBounds,
  windowLabel,
} from "./age-windows";
import {
  FRESH_MAX_AGE_HOURS,
  classifyConfidence,
  classifyFreshness,
  describeFreshness,
  formatAge,
  isPresentableAsCurrent,
  readingAgeHours,
} from "./freshness";

const PUB = "2026-06-13T16:10:00.000Z";

describe("ageHours", () => {
  it("measures from the provider timestamp to the reading", () => {
    expect(ageHours(PUB, "2026-06-13T17:10:00.000Z")).toBe(1);
    expect(ageHours(PUB, "2026-06-14T16:10:00.000Z")).toBe(24);
  });

  it("returns null for a reading that predates publication", () => {
    // Negative age means the timestamps disagree. Guessing which is
    // right would corrupt every downstream comparison.
    expect(ageHours(PUB, "2026-06-13T15:00:00.000Z")).toBeNull();
  });

  it("returns null when either instant is missing or unparseable", () => {
    expect(ageHours(null, PUB)).toBeNull();
    expect(ageHours(PUB, undefined)).toBeNull();
    expect(ageHours("not-a-date", PUB)).toBeNull();
  });
});

describe("classifyAgeWindow", () => {
  it("buckets readings into the window they are closest to", () => {
    expect(classifyAgeWindow(0.5)).toBe("1h");
    expect(classifyAgeWindow(2.9)).toBe("1h");
    expect(classifyAgeWindow(3)).toBe("6h");
    expect(classifyAgeWindow(11.9)).toBe("6h");
    expect(classifyAgeWindow(12)).toBe("24h");
    expect(classifyAgeWindow(47)).toBe("24h");
    expect(classifyAgeWindow(48)).toBe("72h");
    expect(classifyAgeWindow(119)).toBe("72h");
    expect(classifyAgeWindow(120)).toBe("7d");
    expect(classifyAgeWindow(335)).toBe("7d");
    expect(classifyAgeWindow(336)).toBe("older");
  });

  it("covers the whole timeline with no gaps", () => {
    for (let h = 0; h < 400; h += 0.5) {
      expect(classifyAgeWindow(h)).not.toBeNull();
    }
  });

  it("returns null rather than guessing for an unknown age", () => {
    expect(classifyAgeWindow(null)).toBeNull();
    expect(classifyAgeWindow(-1)).toBeNull();
    expect(classifyAgeWindow(Number.NaN)).toBeNull();
  });

  it("every window has bounds and a label", () => {
    for (const w of AGE_WINDOWS) {
      expect(windowBounds(w).maxHours).toBeGreaterThan(windowBounds(w).minHours);
      expect(windowLabel(w).length).toBeGreaterThan(0);
    }
  });
});

describe("comparison gating", () => {
  it("refuses to compare posts read at different ages", () => {
    // The 45-minute-old vs 4-day-old post problem, stated as a guard.
    const fresh = resolveAge(PUB, "2026-06-13T16:55:00.000Z"); // 0.75h -> 1h
    const old = resolveAge(PUB, "2026-06-17T16:10:00.000Z");   // 96h  -> 72h
    expect(fresh.ageWindow).toBe("1h");
    expect(old.ageWindow).toBe("72h");
    expect(comparableInWindow(fresh, old)).toBe(false);
  });

  it("allows comparison inside one window", () => {
    expect(comparableInWindow({ ageWindow: "24h" }, { ageWindow: "24h" })).toBe(true);
  });

  it("never treats two unknown ages as comparable", () => {
    expect(comparableInWindow({ ageWindow: null }, { ageWindow: null })).toBe(false);
  });

  it("returns null for a window with no reading — never interpolates", () => {
    const readings = [
      { ageWindow: "1h" as const, value: 5 },
      { ageWindow: "7d" as const, value: 40 },
    ];
    expect(readingForWindow(readings, "1h")).toBe(5);
    // A 24h value could be "guessed" between 5 and 40. It must not be.
    expect(readingForWindow(readings, "24h")).toBeNull();
  });
});

describe("snapshotSchedule", () => {
  it("plans one refresh per comparison window", () => {
    const plan = snapshotSchedule(PUB);
    expect(plan.map((p) => p.window)).toEqual(["1h", "6h", "24h", "72h", "7d"]);
    expect(plan[0].atIso).toBe("2026-06-13T17:10:00.000Z");
    expect(plan[4].atIso).toBe("2026-06-20T16:10:00.000Z");
  });

  it("returns nothing for an unparseable publication time", () => {
    expect(snapshotSchedule("nope")).toEqual([]);
  });
});

describe("freshness", () => {
  const NOW = "2026-08-19T12:00:00.000Z";

  it("calls a recent reading fresh and an old one stale", () => {
    expect(
      classifyFreshness({ fetchedAtIso: "2026-08-19T11:00:00.000Z", nowIso: NOW, status: "connected" }),
    ).toBe("fresh");
    expect(
      classifyFreshness({ fetchedAtIso: "2026-08-01T12:00:00.000Z", nowIso: NOW, status: "connected" }),
    ).toBe("stale");
  });

  it("uses the sweep cooldown as the freshness boundary", () => {
    const atBoundary = new Date(Date.parse(NOW) - FRESH_MAX_AGE_HOURS * 3_600_000).toISOString();
    expect(classifyFreshness({ fetchedAtIso: atBoundary, nowIso: NOW, status: "connected" })).toBe("fresh");
  });

  it("reports rate limiting and provider errors ahead of age", () => {
    // The operator needs to know the number is not being updated, even
    // if a good value is still cached.
    expect(
      classifyFreshness({ fetchedAtIso: NOW, nowIso: NOW, status: "connected", rateLimited: true }),
    ).toBe("rate_limited");
    expect(
      classifyFreshness({ fetchedAtIso: NOW, nowIso: NOW, status: "connected", providerError: true }),
    ).toBe("provider_error");
  });

  it("never calls an unsupported or never-read metric fresh", () => {
    expect(classifyFreshness({ fetchedAtIso: NOW, nowIso: NOW, status: "unsupported" })).toBe("unavailable");
    expect(classifyFreshness({ fetchedAtIso: null, nowIso: NOW, status: "pending" })).toBe("unavailable");
  });

  it("treats a future reading as stale, not fresh", () => {
    expect(
      classifyFreshness({ fetchedAtIso: "2027-01-01T00:00:00.000Z", nowIso: NOW, status: "connected" }),
    ).toBe("stale");
  });

  it("only fresh data may be presented without a caveat", () => {
    expect(isPresentableAsCurrent("fresh")).toBe(true);
    for (const f of ["stale", "unavailable", "rate_limited", "provider_error"] as const) {
      expect(isPresentableAsCurrent(f)).toBe(false);
    }
  });

  it("never describes stale data as live or current", () => {
    for (const f of ["stale", "unavailable", "rate_limited", "provider_error"] as const) {
      const text = describeFreshness(f, 500).toLowerCase();
      expect(text).not.toMatch(/\blive\b|\bcurrent\b|\bup to date\b/);
    }
    expect(describeFreshness("stale", 500)).toContain("not refreshed since");
  });

  it("attaches a readable age", () => {
    expect(formatAge(0.5)).toBe("30 minutes");
    expect(formatAge(1)).toBe("1 hour");
    expect(formatAge(72)).toBe("3 days");
    expect(readingAgeHours("2026-08-19T11:00:00.000Z", NOW)).toBe(1);
    expect(readingAgeHours(null, NOW)).toBeNull();
  });
});

describe("confidence", () => {
  it("is verified only when every supported metric came back", () => {
    const supported = ["likes", "replies", "reposts", "quotes", "bookmarks", "impressions"];
    expect(
      classifyConfidence(supported, {
        likes: 1, replies: 0, reposts: 0, quotes: 0, bookmarks: 0, impressions: 12,
      }),
    ).toBe("verified");
  });

  it("is partial when the provider omitted a supported metric", () => {
    // X returns all six public_metrics together, so a gap signals a
    // shape change worth noticing — not a post with no bookmarks.
    expect(classifyConfidence(["likes", "impressions"], { likes: 1 })).toBe("partial");
  });

  it("is unknown when nothing came back", () => {
    expect(classifyConfidence(["likes"], {})).toBe("unknown");
    expect(classifyConfidence([], { likes: 1 })).toBe("unknown");
  });
});
