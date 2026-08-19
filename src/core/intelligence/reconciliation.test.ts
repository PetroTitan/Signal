import { describe, expect, it } from "vitest";
import { reconcile, type KnownPublication, type ProviderPost } from "./reconciliation";
import { parseBlueskyAuthorFeed, parseXTimeline } from "./reconciliation-reader";
import { containsCausalClaim } from "./statistics";

/**
 * The real reconciliation, from the Phase 0 audit.
 * webmasterid.bsky.social: Signal published 12 of the posts in the feed;
 * 6 more are the operator's own, made outside Signal; 1 is a repost.
 */
const SIGNAL_ENGAGEMENT = [1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0];
const EXTERNAL_ENGAGEMENT = [6, 1, 0, 2, 0, 0];

const known: KnownPublication[] = SIGNAL_ENGAGEMENT.map((_, i) => ({
  publishHistoryId: `ph-${i}`,
  platform: "bluesky",
  providerPostId: `at://did/app.bsky.feed.post/sig${i}`,
  publishedAt: `2026-06-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
  mode: "api",
  engagement: SIGNAL_ENGAGEMENT[i],
}));

const providerPosts: ProviderPost[] = [
  ...SIGNAL_ENGAGEMENT.map((engagement, i) => ({
    providerPostId: `at://did/app.bsky.feed.post/sig${i}`,
    platform: "bluesky",
    publishedAt: `2026-06-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
    engagement,
  })),
  ...EXTERNAL_ENGAGEMENT.map((engagement, i) => ({
    providerPostId: `at://did/app.bsky.feed.post/ext${i}`,
    platform: "bluesky",
    publishedAt: `2026-07-${String(i + 25).padStart(2, "0")}T12:00:00Z`,
    engagement,
  })),
  {
    providerPostId: "at://did/app.bsky.feed.post/repost",
    platform: "bluesky",
    publishedAt: "2026-08-14T20:20:00Z",
    engagement: 6,
    isRepost: true,
  },
];

describe("recovering the missing control arm", () => {
  const report = reconcile({ platform: "bluesky", providerPosts, knownPublications: known });

  it("finds the external posts the database could not see", () => {
    // publish_history.mode is 100% 'api', so the control arm is empty
    // there. The posts exist on the provider.
    expect(report.counts.signal_api).toBe(12);
    expect(report.counts.provider_external).toBe(6);
  });

  it("excludes reposts — they are someone else's content", () => {
    expect(report.providerPostsConsidered).toBe(18);
    expect(report.posts.some((p) => p.providerPostId.endsWith("repost"))).toBe(false);
  });

  it("excludes replies, which belong to a conversation", () => {
    const withReply = reconcile({
      platform: "bluesky",
      providerPosts: [
        ...providerPosts,
        {
          providerPostId: "at://did/app.bsky.feed.post/reply",
          platform: "bluesky",
          publishedAt: "2026-08-01T10:00:00Z",
          engagement: 3,
          isReply: true,
        },
      ],
      knownPublications: known,
    });
    expect(withReply.providerPostsConsidered).toBe(18);
  });

  it("never claims to know how an external post was composed", () => {
    expect(report.caveats[0]).toContain("does not know how the externally-published posts were composed");
  });

  it("reports Signal rows the provider feed does not contain", () => {
    const withMissing = reconcile({
      platform: "bluesky",
      providerPosts: providerPosts.slice(1),
      knownPublications: known,
    });
    expect(withMissing.missingFromProvider).toHaveLength(1);
    expect(withMissing.caveats.join(" ")).toContain("could not be found");
  });
});

describe("the comparison stays descriptive", () => {
  const report = reconcile({ platform: "bluesky", providerPosts, knownPublications: known });

  it("is never permitted a verdict at these sample sizes", () => {
    expect(report.comparison!.verdict).toBe("descriptive_only");
    expect(report.comparison!.causalClaimPermitted).toBe(false);
  });

  it("reports both medians with n attached", () => {
    expect(report.comparison!.summary).toContain("n=12");
    expect(report.comparison!.summary).toContain("n=6");
  });

  it("names the non-overlapping time periods as a specific confound", () => {
    // Signal posts run through June; the external posts are late July.
    // A generic disclaimer would not tell the operator which problem
    // this particular comparison has.
    expect(report.caveats.join(" ")).toContain("do not overlap in time");
  });

  it("flags the account's first post when it is external", () => {
    const firstIsExternal = reconcile({
      platform: "bluesky",
      providerPosts: [
        {
          providerPostId: "at://did/app.bsky.feed.post/intro",
          platform: "bluesky",
          publishedAt: "2026-05-23T11:41:00Z",
          engagement: 6,
        },
        ...providerPosts,
      ],
      knownPublications: known,
    });
    expect(firstIsExternal.caveats.join(" ")).toContain("first post");
    expect(firstIsExternal.caveats.join(" ")).toContain("follow-driven engagement");
  });

  it("always notes that follower count changed over the period", () => {
    expect(report.caveats.join(" ")).toContain("exposure was not constant");
  });

  it("emits no causal claim anywhere", () => {
    for (const text of [report.summary, ...report.caveats, report.comparison!.summary]) {
      expect(containsCausalClaim(text), text).toBe(false);
    }
  });

  it("produces no comparison at all when nothing has been measured", () => {
    const unmeasured = reconcile({
      platform: "bluesky",
      providerPosts: providerPosts.map((p) => ({ ...p, engagement: null })),
      knownPublications: known.map((k) => ({ ...k, engagement: null })),
    });
    // Nothing measured means there is nothing to compare — null, not an
    // empty comparison rendering zeros.
    expect(unmeasured.comparison).toBeNull();
    expect(unmeasured.summary).toContain("found on the provider");
  });
});

describe("provider feed parsing", () => {
  it("maps a Bluesky feed item and its counters", () => {
    const posts = parseBlueskyAuthorFeed(
      {
        feed: [
          {
            post: {
              uri: "at://did:plc:x/app.bsky.feed.post/abc",
              indexedAt: "2026-06-13T16:15:52Z",
              author: { did: "did:plc:x" },
              record: { text: "Product value is often visible in friction." },
              likeCount: 1,
              repostCount: 0,
              replyCount: 0,
              quoteCount: 0,
              bookmarkCount: 0,
            },
          },
        ],
      },
      "did:plc:x",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].engagement).toBe(1);
    expect(posts[0].excerpt).toContain("Product value");
    expect(posts[0].isRepost).toBe(false);
  });

  it("marks a reposted feed item as a repost", () => {
    const posts = parseBlueskyAuthorFeed(
      {
        feed: [
          {
            reason: { $type: "app.bsky.feed.defs#reasonRepost" },
            post: { uri: "at://other/app.bsky.feed.post/z", indexedAt: "2026-08-14T20:20:00Z", author: { did: "did:plc:other" } },
          },
        ],
      },
      "did:plc:x",
    );
    expect(posts[0].isRepost).toBe(true);
  });

  it("treats another author's post in the feed as not ours", () => {
    const posts = parseBlueskyAuthorFeed(
      { feed: [{ post: { uri: "at://o/app.bsky.feed.post/z", indexedAt: "2026-08-14T20:20:00Z", author: { did: "did:plc:other" } } }] },
      "did:plc:mine",
    );
    expect(posts[0].isRepost).toBe(true);
  });

  it("returns nothing for a malformed payload rather than throwing", () => {
    expect(parseBlueskyAuthorFeed(null, null)).toEqual([]);
    expect(parseBlueskyAuthorFeed({ feed: "nope" }, null)).toEqual([]);
    expect(parseXTimeline({ data: null })).toEqual([]);
  });

  it("maps an X timeline entry and classifies retweets and replies", () => {
    const posts = parseXTimeline({
      data: [
        {
          id: "2065829260963598479",
          text: "Product value often shows up as reduced friction.",
          created_at: "2026-06-13T16:10:00.000Z",
          public_metrics: { like_count: 2, impression_count: 140 },
        },
        { id: "2", text: "rt", referenced_tweets: [{ type: "retweeted", id: "9" }] },
        { id: "3", text: "re", referenced_tweets: [{ type: "replied_to", id: "9" }] },
      ],
    });
    expect(posts[0].engagement).toBe(2); // impressions excluded from engagement
    expect(posts[1].isRepost).toBe(true);
    expect(posts[2].isReply).toBe(true);
  });
});
