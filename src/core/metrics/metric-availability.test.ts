import { describe, expect, it } from "vitest";
import {
  METRIC_KEYS,
  availableMetrics,
  metricAvailability,
  platformLabel,
  renderMetricCell,
  resolveMetricCell,
  supportsImpressions,
} from "./metric-availability";
import { parseBlueskyProfile, parseXUser } from "./account-snapshot-reader";
import {
  MINIMAL_AUDIENCE_CEILING,
  audienceBand,
  audienceSupportsPerformanceAnalysis,
  describeAudience,
  followerDelta,
} from "./account-context";

describe("the Bluesky impressions invariant", () => {
  // NEGATIVE CONTROL (required): treating Bluesky's missing impressions
  // as zero must fail. Bluesky exposes no impressions/views/reach field
  // anywhere in its 152-endpoint surface — verified against the official
  // OpenAPI document and a live read of real posts.
  it("Bluesky impressions are UNSUPPORTED, not merely unavailable", () => {
    expect(metricAvailability("bluesky", "impressions")).toBe("unsupported");
    expect(supportsImpressions("bluesky")).toBe(false);
  });

  it("never renders a number for Bluesky impressions — not even zero", () => {
    const cell = resolveMetricCell("bluesky", "impressions", { likes: 1 });
    expect(cell.kind).toBe("unsupported");
    expect(renderMetricCell(cell)).toBe("Impressions unavailable from Bluesky");
    expect(renderMetricCell(cell)).not.toBe("0");
  });

  it("refuses to report impressions for Bluesky even if a stray key is stored", () => {
    // Defence in depth: availability is consulted BEFORE the value, so a
    // bad write or a future provider change cannot leak a fabricated
    // number into the UI.
    const cell = resolveMetricCell("bluesky", "impressions", {
      impressions: 9999,
    } as never);
    expect(cell.kind).toBe("unsupported");
    expect(renderMetricCell(cell)).not.toContain("9999");
  });

  it("Bluesky views are unsupported too", () => {
    expect(metricAvailability("bluesky", "views")).toBe("unsupported");
  });

  it("Bluesky reports exactly the five counters the AppView returns", () => {
    expect(availableMetrics("bluesky").sort()).toEqual(
      ["bookmarks", "likes", "quotes", "replies", "reposts"].sort(),
    );
  });
});

describe("X per-metric availability", () => {
  // NEGATIVE CONTROL (required): removing X metric capability must fail.
  it("X reports impressions and bookmarks", () => {
    expect(metricAvailability("x", "impressions")).toBe("available");
    expect(metricAvailability("x", "bookmarks")).toBe("available");
    expect(supportsImpressions("x")).toBe(true);
  });

  it("renders a real X impression count", () => {
    const cell = resolveMetricCell("x", "impressions", { impressions: 1520 });
    expect(cell).toEqual({ kind: "value", value: 1520 });
    expect(renderMetricCell(cell)).toBe("1520");
  });

  it("reports a genuine provider-sent zero as a value, not as missing", () => {
    // The rule is never to INVENT a zero, not to hide a reported one.
    expect(resolveMetricCell("x", "likes", { likes: 0 })).toEqual({
      kind: "value",
      value: 0,
    });
  });

  it("says 'not measured yet' when a supported metric has no reading", () => {
    const cell = resolveMetricCell("x", "impressions", {});
    expect(cell.kind).toBe("not_measured");
    expect(renderMetricCell(cell)).toBe("Impressions not measured yet");
  });

  it("says 'not measured yet' when there is no metrics payload at all", () => {
    expect(resolveMetricCell("x", "likes", null).kind).toBe("not_measured");
  });
});

describe("the two platforms are deliberately NOT forced into one shape", () => {
  it("X and Bluesky expose different metric sets", () => {
    expect(availableMetrics("x")).toContain("impressions");
    expect(availableMetrics("bluesky")).not.toContain("impressions");
  });

  it("an unknown platform supports nothing rather than defaulting to available", () => {
    for (const metric of METRIC_KEYS) {
      expect(metricAvailability("mastodon", metric)).toBe("unsupported");
    }
  });

  it("dev.to views are unavailable, not unsupported — the metric exists behind a key", () => {
    expect(metricAvailability("devto", "views")).toBe("unavailable");
    const cell = resolveMetricCell("devto", "views", {});
    expect(cell.kind).toBe("unavailable");
    expect(renderMetricCell(cell)).toContain("not reachable");
  });

  it("labels platforms the way an operator writes them", () => {
    expect(platformLabel("x")).toBe("X");
    expect(platformLabel("bluesky")).toBe("Bluesky");
    expect(platformLabel("devto")).toBe("dev.to");
  });
});

describe("audience context", () => {
  it("classifies the real production identity as having no audience", () => {
    // webmasterid.bsky.social has 1 follower. Near-zero engagement there
    // needs no algorithmic explanation.
    expect(audienceBand(1)).toBe("no_audience");
    expect(audienceSupportsPerformanceAnalysis(1)).toBe(false);
    expect(describeAudience({ platform: "bluesky", followers: 1 })).toContain(
      "says nothing about how the platform is treating this account",
    );
  });

  it("uses singular wording for exactly one follower", () => {
    expect(describeAudience({ platform: "bluesky", followers: 1 })).toContain(
      "1 follower.",
    );
  });

  it("classifies the second identity's 11 followers as minimal", () => {
    expect(audienceBand(11)).toBe("minimal_audience");
    expect(audienceSupportsPerformanceAnalysis(11)).toBe(false);
  });

  it("only permits performance analysis above the minimal ceiling", () => {
    expect(audienceSupportsPerformanceAnalysis(MINIMAL_AUDIENCE_CEILING)).toBe(true);
    expect(audienceSupportsPerformanceAnalysis(MINIMAL_AUDIENCE_CEILING - 1)).toBe(false);
  });

  it("treats an unknown follower count as unknown, never as zero", () => {
    expect(audienceBand(null)).toBe("unknown");
    expect(audienceBand(undefined)).toBe("unknown");
    expect(describeAudience({ platform: "x", followers: null })).toContain(
      "unavailable",
    );
  });

  it("uses flat language — no loaded labels", () => {
    for (const n of [0, 1, 5, 50, 5000, null]) {
      const text = describeAudience({ platform: "bluesky", followers: n });
      expect(text.toLowerCase()).not.toMatch(/dead|failing|bad|shadowban|penal/);
    }
  });

  it("reports a follower delta only when both readings are known", () => {
    expect(followerDelta({ followers: 1 }, { followers: 11 })).toBe(10);
    expect(followerDelta({ followers: null }, { followers: 11 })).toBeNull();
    expect(followerDelta(null, { followers: 11 })).toBeNull();
  });
});

describe("provider profile parsing", () => {
  it("maps a real Bluesky profile payload", () => {
    const snap = parseBlueskyProfile(
      {
        did: "did:plc:vngr5gncxccrjahhabqph5zc",
        handle: "webmasterid.bsky.social",
        followersCount: 1,
        followsCount: 10,
        postsCount: 22,
        createdAt: "2026-05-23T11:23:46.863Z",
      },
      "2026-08-19T10:00:00.000Z",
    );
    expect(snap).toMatchObject({
      platform: "bluesky",
      handle: "webmasterid.bsky.social",
      providerAccountId: "did:plc:vngr5gncxccrjahhabqph5zc",
      followers: 1,
      following: 10,
      postCount: 22,
      source: "bluesky_getprofile",
    });
  });

  it("returns null rather than a half-built snapshot on a bad payload", () => {
    expect(parseBlueskyProfile(null, "t")).toBeNull();
    expect(parseBlueskyProfile({ followersCount: 3 }, "t")).toBeNull();
  });

  it("leaves an absent Bluesky counter null instead of zero", () => {
    const snap = parseBlueskyProfile({ handle: "a.bsky.social" }, "t");
    expect(snap?.followers).toBeNull();
    expect(snap?.postCount).toBeNull();
  });

  it("reads either documented X post-count field name", () => {
    const withPostCount = parseXUser(
      { data: { id: "1", username: "Webmasteridcore", public_metrics: { post_count: 15 } } },
      "t",
    );
    const withTweetCount = parseXUser(
      { data: { id: "1", username: "Webmasteridcore", public_metrics: { tweet_count: 15 } } },
      "t",
    );
    // The data dictionary and the /2/users/me schema disagree on the
    // name; guessing one would silently drop the value.
    expect(withPostCount?.postCount).toBe(15);
    expect(withTweetCount?.postCount).toBe(15);
  });

  it("maps X follower counts and returns null for anything missing", () => {
    const snap = parseXUser(
      {
        data: {
          id: "9",
          username: "PetroHrys",
          public_metrics: { followers_count: 42 },
        },
      },
      "t",
    );
    expect(snap?.followers).toBe(42);
    expect(snap?.following).toBeNull();
  });
});
