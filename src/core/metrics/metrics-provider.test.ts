import { describe, expect, it } from "vitest";
import {
  coerceCount,
  describeMetrics,
  metricCapability,
  metricSource,
  unavailableResult,
  unsupportedResult,
} from "./metrics-provider";

describe("metricCapability", () => {
  it("bluesky + reddit are verified (public reads)", () => {
    expect(metricCapability("bluesky")).toBe("verified");
    expect(metricCapability("reddit")).toBe("verified");
  });
  it("x is unavailable (tier-gated)", () => {
    expect(metricCapability("x")).toBe("unavailable");
  });
  it("everything else is unsupported", () => {
    for (const p of ["linkedin", "threads", "instagram", "youtube", "telegram", "devto", "hashnode", "unknown"]) {
      expect(metricCapability(p)).toBe("unsupported");
    }
  });
});

describe("metricSource", () => {
  it("labels the verified sources", () => {
    expect(metricSource("bluesky")).toBe("bluesky_getposts");
    expect(metricSource("reddit")).toBe("reddit_info");
    expect(metricSource("x")).toBe("x_api_v2");
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
  });
  it("uses honest copy for non-connected states (never fake values)", () => {
    expect(describeMetrics({ status: "unsupported", metrics: {} })).toMatch(/not supported/i);
    expect(describeMetrics({ status: "unavailable", metrics: {} })).toMatch(/unavailable/i);
    expect(describeMetrics({ status: "pending", metrics: {} })).toMatch(/not connected/i);
  });
});
