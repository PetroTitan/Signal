import { describe, expect, it } from "vitest";
import {
  BURST_MIN_POSTS,
  DORMANT_AFTER_DAYS,
  INACTIVE_AFTER_DAYS,
  analyzeCadence,
  analyzeCadenceByPlatform,
  detectBursts,
  type CadencePost,
} from "./cadence";
import { containsCausalClaim } from "./statistics";

/** The real X publication timestamps, 28 May – 15 Aug 2026. */
const REAL_X: CadencePost[] = [
  "2026-05-28T15:35:00Z", "2026-05-30T12:10:00Z", "2026-06-02T13:00:00Z",
  "2026-06-03T14:05:00Z", "2026-06-04T17:20:00Z", "2026-06-05T18:50:00Z",
  "2026-06-07T16:00:00Z", "2026-06-08T16:55:00Z", "2026-06-09T16:00:00Z",
  "2026-06-09T20:00:00Z", "2026-06-10T17:00:00Z", "2026-06-11T16:05:00Z",
  "2026-06-12T14:05:00Z", "2026-06-13T16:10:00Z", "2026-08-15T14:05:00Z",
].map((publishedAt, i) => ({ id: `x${i}`, platform: "x", publishedAt }));

/** Just before the 15 Aug post — the middle of the 63-day silence. */
const DURING_SILENCE = "2026-08-14T00:00:00Z";
const AFTER_LAST = "2026-08-19T12:00:00Z";

describe("the real cadence is NOT flagged as over-posting", () => {
  it("reports roughly one post a day as the typical gap", () => {
    const c = analyzeCadence(REAL_X, "x", AFTER_LAST);
    expect(c.totalPosts).toBe(15);
    // Measured median interval was 25.1h across the real series.
    expect(c.medianIntervalHours).toBeGreaterThan(20);
    expect(c.medianIntervalHours).toBeLessThan(30);
  });

  it("raises no burst for the two same-day doubles", () => {
    // 9 June had posts at 16:00 and 20:00 — two posts, four hours apart.
    // A model that called that a burst would be inventing a problem.
    expect(analyzeCadence(REAL_X, "x", AFTER_LAST).bursts).toHaveLength(0);
  });

  it("never prescribes a posting rate", () => {
    const c = analyzeCadence(REAL_X, "x", AFTER_LAST);
    for (const line of c.observations) {
      expect(line).not.toMatch(/should post|you must post|post more|post less|optimal/i);
      expect(containsCausalClaim(line)).toBe(false);
    }
  });
});

describe("the 63-day silence IS detected", () => {
  it("classifies the account as dormant mid-silence", () => {
    const beforeAugust = REAL_X.slice(0, 14);
    const c = analyzeCadence(beforeAugust, "x", DURING_SILENCE);
    expect(c.state).toBe("dormant");
    expect(c.daysSinceLastPost).toBeGreaterThan(60);
    expect(c.observations.join(" ")).toContain("inactive account");
  });

  it("says recent performance reflects inactivity, not post quality", () => {
    const c = analyzeCadence(REAL_X.slice(0, 14), "x", DURING_SILENCE);
    expect(c.observations.join(" ")).toContain(
      "reflects an inactive account rather than how any particular post was received",
    );
  });

  it("distinguishes paused from dormant", () => {
    const one: CadencePost[] = [{ id: "a", platform: "x", publishedAt: "2026-08-01T00:00:00Z" }];
    const paused = analyzeCadence(one, "x", "2026-08-18T00:00:00Z");
    expect(paused.daysSinceLastPost).toBeGreaterThanOrEqual(INACTIVE_AFTER_DAYS);
    expect(paused.state).toBe("paused");

    const dormant = analyzeCadence(one, "x", "2026-10-01T00:00:00Z");
    expect(dormant.daysSinceLastPost).toBeGreaterThanOrEqual(DORMANT_AFTER_DAYS);
    expect(dormant.state).toBe("dormant");
  });

  it("counts an account with no posts as never_published", () => {
    const c = analyzeCadence([], "bluesky", AFTER_LAST);
    expect(c.state).toBe("never_published");
    expect(c.observations[0]).toContain("No posts recorded");
  });
});

describe("windows and intervals", () => {
  it("counts posts in the trailing 24h / 7d / 30d windows", () => {
    const posts: CadencePost[] = [
      { id: "a", platform: "x", publishedAt: "2026-08-19T10:00:00Z" },
      { id: "b", platform: "x", publishedAt: "2026-08-17T10:00:00Z" },
      { id: "c", platform: "x", publishedAt: "2026-08-01T10:00:00Z" },
      { id: "d", platform: "x", publishedAt: "2026-05-01T10:00:00Z" },
    ];
    const c = analyzeCadence(posts, "x", AFTER_LAST);
    expect(c.postsLast24h).toBe(1);
    expect(c.postsLast7d).toBe(2);
    expect(c.postsLast30d).toBe(3);
  });

  it("withholds interval statistics below the minimum sample", () => {
    const two: CadencePost[] = [
      { id: "a", platform: "x", publishedAt: "2026-08-18T10:00:00Z" },
      { id: "b", platform: "x", publishedAt: "2026-08-19T10:00:00Z" },
    ];
    const c = analyzeCadence(two, "x", AFTER_LAST);
    expect(c.medianIntervalHours).toBeNull();
    expect(c.observations.join(" ")).toContain("too few to describe a posting rhythm");
  });

  it("reports the shortest and longest gaps once there is a sample", () => {
    const c = analyzeCadence(REAL_X, "x", AFTER_LAST);
    expect(c.shortestIntervalHours).toBeCloseTo(4, 0);
    // The 63-day silence is the longest gap.
    expect(c.longestGapHours).toBeGreaterThan(1400);
  });
});

describe("burst detection", () => {
  it("fires only at the configured density", () => {
    const base = Date.parse("2026-06-01T08:00:00Z");
    const posts = Array.from({ length: BURST_MIN_POSTS }, (_, i) => ({
      id: `p${i}`,
      platform: "x",
      publishedAt: new Date(base + i * 3600_000).toISOString(),
    }));
    expect(detectBursts(posts)).toHaveLength(1);
    expect(detectBursts(posts.slice(0, BURST_MIN_POSTS - 1))).toHaveLength(0);
  });

  it("reports one finding per cluster, not one per overlapping window", () => {
    const base = Date.parse("2026-06-01T08:00:00Z");
    const posts = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      platform: "x",
      publishedAt: new Date(base + i * 30 * 60_000).toISOString(),
    }));
    expect(detectBursts(posts)).toHaveLength(1);
    expect(detectBursts(posts)[0].posts).toBe(5);
  });

  it("does not merge clusters separated by more than the window", () => {
    const day1 = Date.parse("2026-06-01T08:00:00Z");
    const day2 = Date.parse("2026-06-05T08:00:00Z");
    const posts = [day1, day2].flatMap((base, g) =>
      Array.from({ length: 3 }, (_, i) => ({
        id: `g${g}p${i}`,
        platform: "x",
        publishedAt: new Date(base + i * 3600_000).toISOString(),
      })),
    );
    expect(detectBursts(posts)).toHaveLength(2);
  });
});

describe("per-platform analysis", () => {
  it("analyses each platform separately", () => {
    const posts: CadencePost[] = [
      ...REAL_X.slice(0, 3),
      { id: "b1", platform: "bluesky", publishedAt: "2026-08-15T14:25:00Z" },
    ];
    const signals = analyzeCadenceByPlatform(posts, AFTER_LAST);
    expect(signals.map((s) => s.platform)).toEqual(["bluesky", "x"]);
    expect(signals.find((s) => s.platform === "bluesky")!.totalPosts).toBe(1);
  });

  it("is deterministic for the same input and clock", () => {
    const a = analyzeCadence(REAL_X, "x", AFTER_LAST);
    const b = analyzeCadence([...REAL_X].reverse(), "x", AFTER_LAST);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
