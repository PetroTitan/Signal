import { describe, expect, it } from "vitest";
import {
  X_LOOKUP_BATCH_SIZE,
  X_TWEET_FIELDS,
  batchTweetIds,
  classifyXReadError,
  isXPostId,
  parsePublicMetrics,
  parseXLookupResponse,
  readXRateLimit,
} from "./x-metrics";
import {
  PLATFORM_METRIC_CAPABILITY,
  engagementCount,
  metricCapability,
} from "./metrics-provider";

describe("X capability — the correction this milestone exists for", () => {
  it("X is verified, not unavailable", () => {
    // NEGATIVE CONTROL: flipping this back to "unavailable" must fail.
    // X moved to pay-per-usage in Feb 2026 and impression_count sits in
    // public_metrics behind a bearer token; tweet.read + users.read are
    // already granted on every connected identity.
    expect(PLATFORM_METRIC_CAPABILITY.x).toBe("verified");
    expect(metricCapability("x")).toBe("verified");
  });

  it("asks for public_metrics and created_at, and nothing tier-gated", () => {
    expect(X_TWEET_FIELDS).toContain("public_metrics");
    expect(X_TWEET_FIELDS).toContain("created_at");
    // non_public_metrics / organic_metrics are owned-only and expire at
    // 30 days; requesting them would cost money and 400 for old posts.
    expect(X_TWEET_FIELDS).not.toContain("non_public_metrics");
    expect(X_TWEET_FIELDS).not.toContain("organic_metrics");
    expect(X_TWEET_FIELDS).not.toContain("promoted_metrics");
  });
});

describe("parsePublicMetrics", () => {
  it("maps all six counters X returns together", () => {
    const m = parsePublicMetrics({
      retweet_count: 3,
      reply_count: 2,
      like_count: 10,
      quote_count: 1,
      bookmark_count: 4,
      impression_count: 1520,
    });
    expect(m).toEqual({
      reposts: 3,
      replies: 2,
      likes: 10,
      quotes: 1,
      bookmarks: 4,
      impressions: 1520,
    });
  });

  it("omits a counter the payload did not return — never zero", () => {
    // The whole milestone turns on this distinction.
    const m = parsePublicMetrics({ like_count: 5 });
    expect(m.likes).toBe(5);
    expect(m).not.toHaveProperty("impressions");
    expect(m.impressions).toBeUndefined();
    expect("impressions" in m).toBe(false);
  });

  it("drops malformed counters rather than coercing them", () => {
    const m = parsePublicMetrics({
      like_count: "12",
      reply_count: -1,
      retweet_count: null,
      quote_count: Number.NaN,
      impression_count: 7,
    });
    expect(m).toEqual({ impressions: 7 });
  });

  it("returns an empty object for a missing or non-object payload", () => {
    expect(parsePublicMetrics(undefined)).toEqual({});
    expect(parsePublicMetrics(null)).toEqual({});
    expect(parsePublicMetrics("nope")).toEqual({});
  });

  it("keeps a genuine zero when the provider actually reported zero", () => {
    // Zero IS a real value when the provider sends it. The rule is that
    // we never INVENT one, not that we discard reported zeros.
    const m = parsePublicMetrics({ like_count: 0, impression_count: 0 });
    expect(m.likes).toBe(0);
    expect(m.impressions).toBe(0);
  });
});

describe("engagementCount excludes impressions", () => {
  it("counts interactions only — being shown a post is not an interaction", () => {
    expect(
      engagementCount({ likes: 2, replies: 1, bookmarks: 3, impressions: 9999 }),
    ).toBe(6);
  });
});

describe("parseXLookupResponse", () => {
  it("parses a normal data array", () => {
    const r = parseXLookupResponse({
      data: [
        {
          id: "2065829260963598479",
          created_at: "2026-06-13T16:10:00.000Z",
          public_metrics: { like_count: 1, impression_count: 42 },
        },
      ],
    });
    expect(r.malformed).toBe(false);
    const t = r.found.get("2065829260963598479");
    expect(t?.metrics.impressions).toBe(42);
    expect(t?.createdAt).toBe("2026-06-13T16:10:00.000Z");
  });

  it("treats a top-level errors entry as a MISSING post, not a failure", () => {
    // X returns 200 with a per-id errors array for deleted/invisible
    // posts, so "not found" is a body condition, not a status code.
    const r = parseXLookupResponse({
      errors: [{ value: "999", detail: "Could not find tweet with id: 999." }],
    });
    expect(r.malformed).toBe(false);
    expect(r.missing.has("999")).toBe(true);
    expect(r.found.size).toBe(0);
  });

  it("handles a mixed data + errors envelope", () => {
    const r = parseXLookupResponse({
      data: [{ id: "1", public_metrics: { like_count: 1 } }],
      errors: [{ resource_id: "2" }],
    });
    expect(r.found.has("1")).toBe(true);
    expect(r.missing.has("2")).toBe(true);
  });

  it("flags an envelope that is not an X v2 response at all", () => {
    expect(parseXLookupResponse(null).malformed).toBe(true);
    expect(parseXLookupResponse("<html>502</html>").malformed).toBe(true);
    expect(parseXLookupResponse({ unexpected: true }).malformed).toBe(true);
  });

  it("keeps a post that carries no public_metrics, with empty metrics", () => {
    // Seen the post, got no counters → unavailable downstream, not zero.
    const r = parseXLookupResponse({ data: [{ id: "1" }] });
    expect(r.found.get("1")?.metrics).toEqual({});
  });

  it("skips entries with no usable id rather than throwing", () => {
    const r = parseXLookupResponse({ data: [{ nope: 1 }, null, "x"] });
    expect(r.malformed).toBe(false);
    expect(r.found.size).toBe(0);
  });
});

describe("classifyXReadError", () => {
  it("401 needs a reconnect and is not retryable", () => {
    const e = classifyXReadError(401, {});
    expect(e.kind).toBe("unauthorized");
    expect(e.retryable).toBe(false);
    expect(e.needsOperator).toBe(true);
  });

  it("distinguishes ordinary throttling from a billing usage cap", () => {
    const throttled = classifyXReadError(429, { title: "Too Many Requests" });
    expect(throttled.kind).toBe("rate_limited");
    expect(throttled.retryable).toBe(true);

    // A usage cap will NOT clear by waiting — opposite operator action.
    const capped = classifyXReadError(429, {
      title: "UsageCapExceeded",
      detail: "Usage cap exceeded: Monthly product cap",
    });
    expect(capped.kind).toBe("usage_capped");
    expect(capped.retryable).toBe(false);
    expect(capped.needsOperator).toBe(true);
  });

  it("recognises client-not-enrolled as a billing problem wearing a 403", () => {
    const e = classifyXReadError(403, {
      title: "Client Forbidden",
      detail: "client-not-enrolled",
    });
    expect(e.kind).toBe("payment_required");
    expect(e.message).toContain("console.x.com");
  });

  it("treats a plain 403 as a scope problem", () => {
    const e = classifyXReadError(403, { title: "Forbidden" });
    expect(e.kind).toBe("forbidden");
    expect(e.message).toContain("tweet.read");
  });

  it("maps 402 to a credit problem", () => {
    expect(classifyXReadError(402, {}).kind).toBe("payment_required");
  });

  it("treats 5xx as retryable provider-side error", () => {
    const e = classifyXReadError(503, {});
    expect(e.kind).toBe("server_error");
    expect(e.retryable).toBe(true);
  });

  it("reads nested error arrays without echoing the raw body", () => {
    const e = classifyXReadError(403, {
      errors: [{ message: "client-not-enrolled for this product" }],
    });
    expect(e.kind).toBe("payment_required");
  });
});

describe("readXRateLimit", () => {
  it("normalizes the documented rate-limit headers", () => {
    const h = new Headers({
      "x-rate-limit-limit": "900",
      "x-rate-limit-remaining": "12",
      "x-rate-limit-reset": "1787164800",
    });
    const snap = readXRateLimit(h);
    expect(snap.limit).toBe(900);
    expect(snap.remaining).toBe(12);
    expect(snap.resetAt).toBe(new Date(1787164800 * 1000).toISOString());
  });

  it("returns nulls when the provider sends no headers", () => {
    expect(readXRateLimit(new Headers())).toEqual({
      limit: null,
      remaining: null,
      resetAt: null,
    });
  });
});

describe("batching and id validation", () => {
  it("batches at the documented 100-id lookup limit", () => {
    expect(X_LOOKUP_BATCH_SIZE).toBe(100);
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    expect(batchTweetIds(ids).map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("drops anything that is not a snowflake id", () => {
    expect(batchTweetIds(["123", "at://not-x", "", "456"])).toEqual([["123", "456"]]);
  });

  it("recognises X post ids", () => {
    expect(isXPostId("2065829260963598479")).toBe(true);
    expect(isXPostId("at://did/app.bsky.feed.post/1")).toBe(false);
    expect(isXPostId(null)).toBe(false);
  });
});
