import { describe, expect, it, vi } from "vitest";
import { runProviderSmokeTest } from "./provider-smoke";
import type { MetricsResult } from "../metrics-provider";

const NOW = "2026-08-19T12:00:00.000Z";

/** The real 2026-08-15 Bluesky post, as the AppView actually answered. */
function blueskyConnected(): MetricsResult {
  return {
    status: "connected",
    source: "bluesky_getposts",
    externalPostId: "at://did:plc:nrru4wabbdh4zhnzwhhnvq5r/app.bsky.feed.post/3mt4uuimqhp2e",
    metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0, bookmarks: 0 },
    providerPublishedAt: "2026-08-15T14:25:20.185Z",
  };
}

function profileOk() {
  return {
    ok: true as const,
    snapshot: {
      platform: "bluesky",
      handle: "petrohrys.bsky.social",
      providerAccountId: "did:plc:nrru4wabbdh4zhnzwhhnvq5r",
      followers: 11,
      following: 31,
      postCount: 4,
      createdAt: "2026-08-14T20:15:15.862Z",
      fetchedAt: NOW,
      source: "bluesky_getprofile",
    },
  };
}

const BLUESKY_TARGET = {
  platform: "bluesky",
  expectedProviderPostId: "at://did:plc:nrru4wabbdh4zhnzwhhnvq5r/app.bsky.feed.post/3mt4uuimqhp2e",
  permalink: null,
  handle: "petrohrys.bsky.social",
};

describe("Bluesky smoke test", () => {
  it("passes every check against the real post shape", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r.ok).toBe(true);
    expect(r.providerReadOk).toBe(true);
    expect(r.persistenceOk).toBe(true);
    expect(r.normalized).toEqual({ likes: 1, reposts: 0, replies: 0, quotes: 0, bookmarks: 0 });
  });

  it("verifies impressions are unavailable rather than zero", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    const check = r.checks.find((c) => c.name === "impressions are unavailable, not zero")!;
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("unavailable from Bluesky");
  });

  it("handles the bookmark counter, including a genuine zero", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r.checks.find((c) => c.name === "bookmark counter is handled")!.detail).toContain(
      "bookmarkCount read as 0",
    );
  });

  it("fails when the provider echoes a different post id", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue({ ...blueskyConnected(), externalPostId: "at://other" }),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.includes("post id matches"))!.passed).toBe(false);
  });

  it("reads the account profile", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r.checks.find((c) => c.name === "account profile readable")!.detail).toContain(
      "followers=11",
    );
  });

  it("would REFUSE a fabricated impressions key", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi
        .fn()
        .mockResolvedValue({ ...blueskyConnected(), metrics: { likes: 1, impressions: 500 } }),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r.checks.find((c) => c.name === "no counter was invented")!.passed).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("X smoke test", () => {
  const X_TARGET = {
    platform: "x",
    expectedProviderPostId: "2088628143733023154",
    permalink: "https://x.com/PetroHrys/status/2088628143733023154",
  };

  it("checks impressions are readable", async () => {
    const r = await runProviderSmokeTest(X_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue({
        status: "connected",
        source: "x_api_v2",
        externalPostId: "2088628143733023154",
        metrics: { likes: 2, replies: 0, reposts: 0, quotes: 0, bookmarks: 1, impressions: 140 },
        providerPublishedAt: "2026-08-15T14:05:29.000Z",
      } satisfies MetricsResult),
    });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "impressions are readable")!.detail).toContain("140");
  });

  it("reports a token problem without leaking the token", async () => {
    const r = await runProviderSmokeTest(X_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue({
        status: "unavailable",
        source: "x_api_v2",
        externalPostId: "2088628143733023154",
        metrics: {},
        error: "X returned 401 with Bearer sk-live-SECRETVALUE123",
      } satisfies MetricsResult),
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-live-SECRETVALUE123");
  });
});

describe("nothing is written", () => {
  it("persistence is a dry run and says so", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    const check = r.checks.find((c) => c.name.includes("persistence path"))!;
    expect(check.detail).toContain("Nothing was written");
    expect(r.summary).toContain("nothing was published");
  });

  it("separates provider-read success from persistence success", async () => {
    // The point of the split: a provider can be verified even when the
    // database is not involved at all.
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockResolvedValue(blueskyConnected()),
      fetchProfile: vi.fn().mockResolvedValue(profileOk()),
    });
    expect(r).toHaveProperty("providerReadOk");
    expect(r).toHaveProperty("persistenceOk");
  });

  it("survives a thrown fetcher without leaking anything", async () => {
    const r = await runProviderSmokeTest(BLUESKY_TARGET, {
      nowIso: NOW,
      fetchMetrics: vi.fn().mockRejectedValue(new Error("boom Bearer abc123def456")),
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("abc123def456");
  });
});
