import { describe, expect, it } from "vitest";
import {
  coerceCount,
  describeMetrics,
  engagementCount,
  metricCapability,
  metricSource,
  unavailableReason,
  unavailableResult,
  unsupportedResult,
} from "./metrics-provider";

describe("metricCapability (Phase D.1 audit)", () => {
  it("bluesky + reddit + devto are verified (official public reads)", () => {
    expect(metricCapability("bluesky")).toBe("verified");
    expect(metricCapability("reddit")).toBe("verified");
    expect(metricCapability("devto")).toBe("verified");
  });
  it("x / hashnode / linkedin are unavailable (real API exists but not reachable here)", () => {
    expect(metricCapability("x")).toBe("unavailable");
    expect(metricCapability("hashnode")).toBe("unavailable");
    expect(metricCapability("linkedin")).toBe("unavailable");
  });
  it("telegram / threads / instagram / youtube / unknown are unsupported", () => {
    for (const p of ["telegram", "threads", "instagram", "youtube", "unknown"]) {
      expect(metricCapability(p)).toBe("unsupported");
    }
  });
});

describe("metricSource", () => {
  it("labels the verified + unavailable sources", () => {
    expect(metricSource("bluesky")).toBe("bluesky_getposts");
    expect(metricSource("reddit")).toBe("reddit_info");
    expect(metricSource("devto")).toBe("devto_articles");
    expect(metricSource("x")).toBe("x_api_v2");
  });
});

describe("unavailableReason", () => {
  it("gives an honest, platform-specific explanation (no estimate)", () => {
    expect(unavailableReason("x")).toMatch(/tier/i);
    expect(unavailableReason("hashnode")).toMatch(/graphql/i);
    expect(unavailableReason("linkedin")).toMatch(/marketing api/i);
  });
});

describe("engagementCount", () => {
  it("sums only the verified interaction counts present (views excluded)", () => {
    expect(engagementCount({ likes: 3, reposts: 1, replies: 2, quotes: 1 })).toBe(7);
    expect(engagementCount({ score: 12, comments: 4 })).toBe(16);
    expect(engagementCount({ reactions: 5, comments: 2, views: 999 })).toBe(7);
    expect(engagementCount({})).toBe(0);
  });
});

describe("result builders", () => {
  it("unsupported carries empty metrics + status", () => {
    const r = unsupportedResult("youtube");
    expect(r.status).toBe("unsupported");
    expect(r.metrics).toEqual({});
  });
  it("unavailable carries the external id + optional error, no metrics", () => {
    const r = unavailableResult("x", "tweet-1", "tier gated");
    expect(r.status).toBe("unavailable");
    expect(r.externalPostId).toBe("tweet-1");
    expect(r.error).toBe("tier gated");
    expect(r.metrics).toEqual({});
  });
});

describe("coerceCount", () => {
  it("accepts non-negative integers, rounds, rejects junk", () => {
    expect(coerceCount(5)).toBe(5);
    expect(coerceCount(5.7)).toBe(6);
    expect(coerceCount(-1)).toBeUndefined();
    expect(coerceCount("5")).toBeUndefined();
    expect(coerceCount(null)).toBeUndefined();
    expect(coerceCount(NaN)).toBeUndefined();
  });
});

describe("describeMetrics", () => {
  it("renders verified counts only", () => {
    expect(
      describeMetrics({ status: "connected", metrics: { likes: 3, reposts: 1 } }),
    ).toBe("3 likes · 1 reposts");
    expect(describeMetrics({ status: "connected", metrics: { score: 12, comments: 4 } })).toBe(
      "score 12 · 4 comments",
    );
    expect(
      describeMetrics({ status: "connected", metrics: { reactions: 7, comments: 2 } }),
    ).toBe("7 reactions · 2 comments");
  });
  it("uses honest copy for non-connected states (never fake values)", () => {
    expect(describeMetrics({ status: "unsupported", metrics: {} })).toMatch(/not supported/i);
    expect(describeMetrics({ status: "unavailable", metrics: {} })).toMatch(/unavailable/i);
    expect(describeMetrics({ status: "pending", metrics: {} })).toMatch(/not connected/i);
  });
});
