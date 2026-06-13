import { describe, expect, it } from "vitest";
import {
  computeBestPublishingTime,
  computePublishingConsistency,
  computeResultsIntelligence,
  computeTopPlatforms,
  computeTopPosts,
  DEFAULT_THRESHOLDS,
  type ResultDataPoint,
} from "./results-intelligence";

function point(over: Partial<ResultDataPoint> = {}): ResultDataPoint {
  return {
    publishHistoryId: Math.random().toString(36).slice(2),
    title: "t",
    platform: "bluesky",
    permalink: null,
    publishedAtIso: "2026-06-01T10:00:00.000Z",
    engagement: 5,
    metricsStatus: "connected",
    ...over,
  };
}

const lowThresholds = {
  ...DEFAULT_THRESHOLDS,
  minConnectedForTopPosts: 2,
  minConnectedPerPlatform: 2,
  minPostsForConsistency: 2,
  minConnectedForBestTime: 2,
};

describe("computeTopPosts", () => {
  it("returns insufficient_data below threshold", () => {
    const r = computeTopPosts([point()], DEFAULT_THRESHOLDS);
    expect(r.kind).toBe("insufficient_data");
    if (r.kind === "insufficient_data") expect(r.needed).toBe(3);
  });

  it("ranks connected posts by engagement desc, ignores unconnected", () => {
    const r = computeTopPosts(
      [
        point({ publishHistoryId: "a", engagement: 3 }),
        point({ publishHistoryId: "b", engagement: 9 }),
        point({ publishHistoryId: "c", engagement: 1 }),
        point({ publishHistoryId: "d", engagement: null, metricsStatus: "unavailable" }),
      ],
      lowThresholds,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.posts.map((p) => p.publishHistoryId)).toEqual(["b", "a", "c"]);
    }
  });
});

describe("computeTopPlatforms", () => {
  it("averages verified engagement per platform, only those meeting min", () => {
    const r = computeTopPlatforms(
      [
        point({ platform: "bluesky", engagement: 10 }),
        point({ platform: "bluesky", engagement: 20 }),
        point({ platform: "reddit", engagement: 100 }), // only 1 → excluded at min 2
      ],
      lowThresholds,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.platforms).toHaveLength(1);
      expect(r.platforms[0]).toMatchObject({ platform: "bluesky", posts: 2, avgEngagement: 15 });
    }
  });

  it("insufficient_data when no platform meets the minimum", () => {
    const r = computeTopPlatforms([point({ engagement: 5 })], lowThresholds);
    expect(r.kind).toBe("insufficient_data");
  });
});

describe("computePublishingConsistency", () => {
  it("uses real timestamps only (engagement irrelevant)", () => {
    const r = computePublishingConsistency(
      [
        point({ publishedAtIso: "2026-06-01T00:00:00Z", engagement: null, metricsStatus: "pending" }),
        point({ publishedAtIso: "2026-06-08T00:00:00Z", engagement: null, metricsStatus: "pending" }),
        point({ publishedAtIso: "2026-06-15T00:00:00Z", engagement: null, metricsStatus: "pending" }),
      ],
      lowThresholds,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.stats.totalPosts).toBe(3);
      expect(r.stats.activeDays).toBe(3);
      expect(r.stats.spanDays).toBe(14);
      expect(r.stats.longestGapDays).toBe(7);
    }
  });

  it("insufficient_data below the minimum posts", () => {
    const r = computePublishingConsistency([point()], DEFAULT_THRESHOLDS);
    expect(r.kind).toBe("insufficient_data");
  });
});

describe("computeBestPublishingTime", () => {
  it("picks the UTC hour/weekday with highest verified avg engagement", () => {
    const r = computeBestPublishingTime(
      [
        // Mon 2026-06-01 09:00 UTC, high engagement
        point({ publishedAtIso: "2026-06-01T09:00:00Z", engagement: 100 }),
        point({ publishedAtIso: "2026-06-08T09:00:00Z", engagement: 80 }),
        // Tue 2026-06-02 18:00 UTC, low
        point({ publishedAtIso: "2026-06-02T18:00:00Z", engagement: 1 }),
      ],
      lowThresholds,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.stats.bestHour?.bucket).toBe(9);
      expect(r.stats.bestWeekday?.label).toBe("Mon");
      expect(r.stats.timezone).toBe("UTC");
      expect(r.stats.sampleSize).toBe(3);
    }
  });

  it("insufficient_data when too few measured posts", () => {
    const r = computeBestPublishingTime([point(), point()], DEFAULT_THRESHOLDS);
    expect(r.kind).toBe("insufficient_data");
  });
});

describe("computeResultsIntelligence (aggregate)", () => {
  it("counts totals + only-connected measured posts; no fabrication", () => {
    const intel = computeResultsIntelligence([
      point({ engagement: 5 }),
      point({ engagement: null, metricsStatus: "unsupported" }),
    ]);
    expect(intel.totalPosts).toBe(2);
    expect(intel.connectedPosts).toBe(1);
    // Below default thresholds → honest insufficient_data, not invented numbers.
    expect(intel.topPosts.kind).toBe("insufficient_data");
    expect(intel.bestTime.kind).toBe("insufficient_data");
  });
});
