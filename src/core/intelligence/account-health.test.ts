import { describe, expect, it } from "vitest";
import { buildAccountHealthPanel, type HealthInput } from "./account-health";
import { NEVER_AUTOMATED, recommendNextActions } from "./recommendations";
import { containsCausalClaim } from "./statistics";

const NOW = "2026-08-19T12:00:00Z";

/** The real webmasterid.bsky.social situation. */
function realInput(over: Partial<HealthInput> = {}): HealthInput {
  const posts = [
    "2026-05-26T12:40:00Z", "2026-05-27T14:40:00Z", "2026-05-28T15:40:00Z",
    "2026-05-30T12:10:00Z", "2026-06-02T12:55:00Z", "2026-06-03T14:05:00Z",
    "2026-06-03T19:50:00Z", "2026-06-04T17:50:00Z", "2026-06-07T17:00:00Z",
    "2026-06-09T20:05:00Z", "2026-06-12T14:10:00Z", "2026-06-13T16:15:00Z",
  ].map((publishedAt, i) => ({
    id: `b${i}`,
    platform: "bluesky",
    publishedAt,
    body: `Distinct analytics observation number ${i} about instrumentation and evidence loops.`,
  }));

  return {
    platform: "bluesky",
    handle: "webmasterid.bsky.social",
    nowIso: NOW,
    account: {
      platform: "bluesky",
      handle: "webmasterid.bsky.social",
      providerAccountId: "did:plc:vngr5gncxccrjahhabqph5zc",
      followers: 1,
      following: 10,
      postCount: 22,
      createdAt: "2026-05-23T11:23:46Z",
      fetchedAt: NOW,
      source: "bluesky_getprofile",
    },
    posts,
    otherPlatformPosts: [],
    engagementSeries: [1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0],
    metricsFreshness: "fresh",
    metricsAgeHours: 1,
    ...over,
  };
}

describe("the panel is a panel, not a score", () => {
  const panel = buildAccountHealthPanel(realInput());

  it("exposes no composite score of any kind", () => {
    expect(panel).not.toHaveProperty("score");
    expect(panel).not.toHaveProperty("overallScore");
    expect(panel).not.toHaveProperty("health");
    expect(panel).not.toHaveProperty("grade");
  });

  it("gives every signal evidence, timeframe, source and confidence", () => {
    expect(panel.signals.length).toBeGreaterThanOrEqual(9);
    for (const s of panel.signals) {
      expect(s.evidence.length, s.key).toBeGreaterThan(10);
      expect(s.timeframe.length, s.key).toBeGreaterThan(0);
      expect(s.source.length, s.key).toBeGreaterThan(0);
      expect(["high", "medium", "low", "none"]).toContain(s.confidence);
    }
  });

  it("never uses loaded language", () => {
    const all = [panel.summary, ...panel.signals.flatMap((s) => [s.evidence, s.label, s.value ?? ""])];
    for (const text of all) {
      expect(text.toLowerCase()).not.toMatch(/\bdead\b|shadowban|\bspammy\b|\bfailing\b|\bbad\b|\bpunish/);
      expect(containsCausalClaim(text), text).toBe(false);
    }
  });
});

describe("the one-follower account is described honestly", () => {
  const panel = buildAccountHealthPanel(realInput());
  const byKey = (k: string) => panel.signals.find((s) => s.key === k)!;

  it("flags the audience as the reason performance cannot be read", () => {
    const audience = byKey("audience");
    expect(audience.state).toBe("advisory");
    expect(audience.value).toBe("1 follower");
    expect(audience.evidence).toContain("says nothing about how the platform is treating this account");
  });

  it("refuses a performance trend because the audience is too small", () => {
    const perf = byKey("recent_performance");
    expect(perf.state).toBe("insufficient_data");
    expect(perf.evidence).toContain("audience is too small for engagement to carry signal");
  });

  it("reports the 67-day silence as advisory", () => {
    const inactivity = byKey("inactivity");
    expect(inactivity.state).toBe("advisory");
    expect(inactivity.evidence).toContain("describe an inactive account");
  });

  it("states that Bluesky has no impressions as a platform property", () => {
    const visibility = byKey("interaction_visibility");
    expect(visibility.value).toBe("no impressions");
    expect(visibility.evidence).toContain("not a gap in this account's data");
  });

  it("does not flag the ~1/day cadence", () => {
    expect(byKey("cadence").state).toBe("normal");
  });

  it("notes that none of the posts carry a link", () => {
    expect(byKey("link_frequency").evidence).toContain("None of the recent posts carry an outbound link");
  });
});

describe("provider and freshness states are distinct", () => {
  it("surfaces stale, rate-limited and provider-error separately", () => {
    for (const [freshness, expected] of [
      ["stale", "stale"],
      ["rate_limited", "rate_limited"],
      ["provider_error", "provider_error"],
    ] as const) {
      const panel = buildAccountHealthPanel(realInput({ metricsFreshness: freshness, metricsAgeHours: 400 }));
      expect(panel.signals.find((s) => s.key === "data_freshness")!.state).toBe(expected);
    }
  });

  it("reports unavailable when nothing has ever been read", () => {
    const panel = buildAccountHealthPanel(realInput({ metricsFreshness: null, metricsAgeHours: null }));
    expect(panel.signals.find((s) => s.key === "data_freshness")!.state).toBe("unavailable");
  });

  it("marks audience unavailable rather than zero when unread", () => {
    const panel = buildAccountHealthPanel(realInput({ account: null }));
    const audience = panel.signals.find((s) => s.key === "audience")!;
    expect(audience.state).toBe("unavailable");
    expect(audience.value).toBeNull();
  });
});

describe("cross-platform signal", () => {
  it("flags the real historical pair when both platforms are present", () => {
    const body =
      "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. " +
      "CV builder. Invoice maker. Card scanner. No brand needed, no launch needed.";
    const panel = buildAccountHealthPanel(
      realInput({
        posts: [{ id: "b", platform: "bluesky", publishedAt: "2026-08-15T14:25:00Z", body: `${body} Same demand this year.` }],
        otherPlatformPosts: [{ id: "x", platform: "x", publishedAt: "2026-08-15T14:05:00Z", body }],
      }),
    );
    const sim = panel.signals.find((s) => s.key === "cross_platform_similarity")!;
    expect(sim.state).toBe("advisory");
    expect(sim.evidence).toContain("Cross-platform similarity");
  });

  it("needs two platforms before it says anything", () => {
    const panel = buildAccountHealthPanel(realInput({ otherPlatformPosts: [] }));
    expect(panel.signals.find((s) => s.key === "cross_platform_similarity")!.state).toBe(
      "insufficient_data",
    );
  });
});

describe("recommendations are advice, never actions", () => {
  const panel = buildAccountHealthPanel(realInput());
  const recs = recommendNextActions(panel);

  it("marks every recommendation as non-automatable", () => {
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.automatable).toBe(false);
      expect(r.rationale.length).toBeGreaterThan(10);
    }
  });

  it("tells the operator to grow the audience before reading performance", () => {
    expect(recs.some((r) => r.kind === "grow_audience_first")).toBe(true);
  });

  it("recommends replying rather than publishing, and says Signal will not do it", () => {
    const engage = recs.find((r) => r.kind === "engage_manually");
    expect(engage).toBeTruthy();
    expect(engage!.action).toContain("Signal will not do this for you");
    expect(engage!.rationale).toContain("sending is yours");
  });

  it("never proposes an automated engagement action", () => {
    const text = recs.map((r) => `${r.action} ${r.rationale}`).join(" ").toLowerCase();
    for (const forbidden of ["auto-like", "auto like", "automatically follow", "mass reply", "warm-up", "warm up"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(NEVER_AUTOMATED.length).toBeGreaterThan(5);
  });

  it("puts measurement first when nothing has been measured", () => {
    const unmeasured = buildAccountHealthPanel(
      realInput({ engagementSeries: [], metricsFreshness: null, metricsAgeHours: null }),
    );
    const first = recommendNextActions(unmeasured)[0];
    expect(first.kind).toBe("measure_first");
    expect(first.urgency).toBe("now");
  });

  it("says nothing rather than inventing advice for a healthy account", () => {
    const healthy = buildAccountHealthPanel(
      realInput({
        account: { ...realInput().account!, followers: 5000 },
        posts: realInput().posts.map((p) => ({ ...p, publishedAt: "2026-08-19T09:00:00Z" })),
        engagementSeries: Array.from({ length: 30 }, (_, i) => 40 + (i % 7)),
        metricsFreshness: "fresh",
        metricsAgeHours: 1,
      }),
    );
    const recs2 = recommendNextActions(healthy);
    expect(recs2.every((r) => r.automatable === false)).toBe(true);
    expect(recs2.some((r) => r.kind === "grow_audience_first")).toBe(false);
  });

  it("emits no causal claim", () => {
    for (const r of recs) {
      expect(containsCausalClaim(`${r.action} ${r.rationale}`)).toBe(false);
    }
  });
});
