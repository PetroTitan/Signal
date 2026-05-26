import { describe, expect, it } from "vitest";
import { redditAdapter } from "./index";
import {
  computeProviderPayloadHash,
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: "Reddit title",
    body: "selftext body",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: legacyPlatformNativeShape("reddit"),
    target: "testsubreddit",
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("reddit"), ...over };
}

describe("redditAdapter — capabilities", () => {
  it("advertises new_post / link_post / media_post / comment / reply", () => {
    const c = redditAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("link_post")).toBe(true);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.supportedIntents.has("comment")).toBe(true);
    expect(c.supportedIntents.has("reply")).toBe(true);
    expect(c.supportedIntents.has("thread")).toBe(false);
    expect(c.reply.supported).toBe(true);
    expect(c.quote.supported).toBe(false);
    expect(c.requiresTarget).toBe(true);
    expect(c.requiresTitle).toBe(true);
  });
});

describe("redditAdapter — text post (new_post)", () => {
  it("happy path: title + body + subreddit → single_post", () => {
    const p = redditAdapter.buildPreview(
      input({ shape: shape({ intent: "new_post" }) }),
    );
    expect(p.format).toBe("single_post");
    expect(p.blockers).toEqual([]);
    expect(p.routing?.subreddit).toBe("testsubreddit");
    expect(p.routing?.title).toBe("Reddit title");
  });

  it("missing subreddit → subreddit_required", () => {
    const p = redditAdapter.buildPreview(
      input({ target: "", shape: shape({ intent: "new_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("subreddit_required");
  });

  it("missing title → title_required", () => {
    const p = redditAdapter.buildPreview(
      input({ title: "", shape: shape({ intent: "new_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("title_required");
  });

  it("title > 300 chars → reddit_title_exceeds_budget", () => {
    const p = redditAdapter.buildPreview(
      input({ title: "x".repeat(305), shape: shape({ intent: "new_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("reddit_title_exceeds_budget");
  });

  it("empty body → warning only (title-only post is valid on Reddit)", () => {
    const p = redditAdapter.buildPreview(
      input({ body: "", shape: shape({ intent: "new_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).not.toContain("empty_body");
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});

describe("redditAdapter — link_post", () => {
  it("link_post without link → link_required_for_link_post", () => {
    const p = redditAdapter.buildPreview(
      input({ shape: shape({ intent: "link_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "link_required_for_link_post",
    );
  });

  it("link_post with link → format=link_post, routing carries link_url", () => {
    const p = redditAdapter.buildPreview(
      input({
        shape: shape({ intent: "link_post" }),
        linkUrl: "https://example.com/article",
      }),
    );
    expect(p.format).toBe("link_post");
    expect(p.routing?.link_url).toBe("https://example.com/article");
  });
});

describe("redditAdapter — media_post", () => {
  it("media_post without creative → media_required_for_media_post", () => {
    const p = redditAdapter.buildPreview(
      input({ shape: shape({ intent: "media_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "media_required_for_media_post",
    );
  });

  it("media_post with creative → format=media_post, media attached", () => {
    const p = redditAdapter.buildPreview(
      input({
        shape: shape({ intent: "media_post" }),
        creative: {
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: "alt",
          creativeType: "image",
        },
      }),
    );
    expect(p.format).toBe("media_post");
    expect(p.parts[0].media.attached).toBe(true);
  });
});

describe("redditAdapter — comment / reply", () => {
  it("comment without parent → parent_target_required", () => {
    const p = redditAdapter.buildPreview(
      input({ shape: shape({ intent: "comment" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("parent_target_required");
  });

  it("reply with parent t3_id → format=reply, routing carries parent_id", () => {
    const p = redditAdapter.buildPreview(
      input({
        shape: shape({
          intent: "reply",
          replyTarget: { externalId: "t3_abc123", url: null },
        }),
      }),
    );
    expect(p.format).toBe("reply");
    expect(p.routing?.parent_id).toBe("t3_abc123");
  });
});

describe("redditAdapter — payload hash", () => {
  it("hash is deterministic + changes when link_url changes", async () => {
    const a = await computeProviderPayloadHash(
      redditAdapter.buildPreview(
        input({
          shape: shape({ intent: "link_post" }),
          linkUrl: "https://example.com/a",
        }),
      ),
    );
    const b = await computeProviderPayloadHash(
      redditAdapter.buildPreview(
        input({
          shape: shape({ intent: "link_post" }),
          linkUrl: "https://example.com/b",
        }),
      ),
    );
    expect(a).not.toBe(b);
  });
});
