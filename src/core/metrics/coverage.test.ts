import { describe, expect, it } from "vitest";
import {
  FIRST_WINDOW_HOURS,
  classifyCoverage,
  summarizeCoverage,
  windowsDue,
  type PublicationForCoverage,
} from "./coverage";

const NOW = "2026-08-20T12:00:00.000Z";
const OPTS = { nowIso: NOW, seedWindowDays: 14 };

function pub(over: Partial<PublicationForCoverage> = {}): PublicationForCoverage {
  return {
    publishHistoryId: "p1",
    platform: "bluesky",
    accountId: "a1",
    outcome: "published",
    publishedAt: "2026-08-19T12:00:00.000Z",
    providerPostId: "at://did/app.bsky.feed.post/1",
    permalink: null,
    metrics: null,
    ...over,
  };
}

const FULL_BLUESKY = { likes: 1, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 };

describe("THE DENOMINATOR RULE", () => {
  it("excludes blocked and failed attempts — they never reached a platform", () => {
    for (const outcome of ["blocked", "failed"]) {
      const v = classifyCoverage(pub({ outcome }), OPTS);
      expect(v.measurable, outcome).toBe(false);
      expect(v.reason).toContain("nothing reached the platform");
    }
  });

  it("a workspace of blocked attempts does not drag coverage down", () => {
    // 92 attempts, 44 published in the real history. Counting attempts
    // would report ~48% for perfectly measured accounts.
    const publications = [
      ...Array.from({ length: 3 }, (_, i) =>
        pub({
          publishHistoryId: `ok${i}`,
          metrics: { status: "connected", fetchedAt: NOW, freshness: "fresh", ageWindow: "24h", counters: FULL_BLUESKY },
        }),
      ),
      ...Array.from({ length: 9 }, (_, i) => pub({ publishHistoryId: `blk${i}`, outcome: "blocked" })),
    ];
    const [summary] = summarizeCoverage(publications, OPTS);
    expect(summary.publishAttempts).toBe(12);
    expect(summary.publishedPosts).toBe(3);
    expect(summary.measurablePosts).toBe(3);
    expect(summary.coveragePercent).toBe(100);
  });
});

describe("a row existing is not coverage", () => {
  it("a stale reading is stale, not covered", () => {
    const v = classifyCoverage(
      pub({ metrics: { status: "connected", fetchedAt: "2026-08-01T12:00:00Z", freshness: "stale", ageWindow: "7d", counters: FULL_BLUESKY } }),
      OPTS,
    );
    expect(v.state).toBe("stale");
    expect(v.healthy).toBe(false);
  });

  it("a partial counter set is partially_covered", () => {
    const v = classifyCoverage(
      pub({ metrics: { status: "connected", fetchedAt: NOW, freshness: "fresh", ageWindow: "24h", counters: { likes: 1 } } }),
      OPTS,
    );
    expect(v.state).toBe("partially_covered");
    expect(v.reason).toContain("only 1 of the 5 counters");
    expect(v.healthy).toBe(false);
  });

  it("a provider error is provider_error, not covered and not zero", () => {
    const v = classifyCoverage(
      pub({ metrics: { status: "unavailable", fetchedAt: NOW, freshness: "provider_error", ageWindow: null, counters: {} } }),
      OPTS,
    );
    expect(v.state).toBe("provider_error");
  });

  it("rate limiting is reported as an error state for coverage purposes", () => {
    const v = classifyCoverage(
      pub({ metrics: { status: "unavailable", fetchedAt: NOW, freshness: "rate_limited", ageWindow: null, counters: {} } }),
      OPTS,
    );
    expect(v.state).toBe("provider_error");
    expect(v.reason).toContain("not being updated");
  });

  it("a complete fresh reading IS covered", () => {
    const v = classifyCoverage(
      pub({ metrics: { status: "connected", fetchedAt: NOW, freshness: "fresh", ageWindow: "24h", counters: FULL_BLUESKY } }),
      OPTS,
    );
    expect(v.state).toBe("covered");
    expect(v.healthy).toBe(true);
  });
});

describe("age-aware states", () => {
  it("a brand new post is not_yet_due, not missing", () => {
    const v = classifyCoverage(pub({ publishedAt: "2026-08-20T11:45:00Z" }), OPTS);
    expect(v.state).toBe("not_yet_due");
    expect(v.reason).toContain(`${FIRST_WINDOW_HOURS}h`);
  });

  it("an old unmeasured post is outside_recoverable_window and names the backfill", () => {
    // The real production case: June publications, 14-day window.
    const v = classifyCoverage(pub({ publishedAt: "2026-06-13T16:15:00Z" }), OPTS);
    expect(v.state).toBe("outside_recoverable_window");
    expect(v.reason).toContain("bounded backfill");
  });

  it("an in-window unmeasured post is a genuine gap", () => {
    const v = classifyCoverage(pub({ publishedAt: "2026-08-15T14:25:00Z" }), OPTS);
    expect(v.state).toBe("provider_unavailable");
  });

  it("a post with no provider id can never be measured", () => {
    const v = classifyCoverage(pub({ providerPostId: null, permalink: null }), OPTS);
    expect(v.state).toBe("missing_provider_post_id");
    expect(v.measurable).toBe(false);
  });
});

describe("summary", () => {
  it("reports the real production shape honestly", () => {
    const publications = [
      ...Array.from({ length: 12 }, (_, i) =>
        pub({ publishHistoryId: `old${i}`, publishedAt: "2026-06-13T16:15:00Z" }),
      ),
      pub({ publishHistoryId: "recent", publishedAt: "2026-08-15T14:25:00Z" }),
    ];
    const [s] = summarizeCoverage(publications, OPTS);
    expect(s.publishedPosts).toBe(13);
    expect(s.coveragePercent).toBe(0);
    expect(s.backfillRecoverable).toBe(12);
    expect(s.summary).toContain("need the backfill");
    expect(s.oldestMissingPublishedAt).toBe("2026-06-13T16:15:00Z");
  });

  it("separates platforms", () => {
    const summaries = summarizeCoverage(
      [pub(), pub({ publishHistoryId: "x1", platform: "x", providerPostId: "123" })],
      OPTS,
    );
    expect(summaries.map((s) => s.platform)).toEqual(["bluesky", "x"]);
  });

  it("returns null coverage rather than 0% when nothing is measurable", () => {
    const [s] = summarizeCoverage([pub({ outcome: "blocked" })], OPTS);
    expect(s.coveragePercent).toBeNull();
    expect(s.summary).toContain("none published, so none measurable");
  });

  it("windowsDue grows with age", () => {
    expect(windowsDue("2026-08-20T11:30:00Z", NOW)).toEqual(["1h"]);
    expect(windowsDue("2026-08-19T12:00:00Z", NOW)).toEqual(["1h", "6h", "24h"]);
  });
});
