import { describe, expect, it } from "vitest";
import { youtubeAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: "My video",
    body: "Video description.",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: {
      assetUrl: "https://example.com/thumb.jpg",
      sourceUrl: null,
      altText: null,
      creativeType: "image",
    },
    shape: { ...legacyPlatformNativeShape("youtube"), intent: "video_post" },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return {
    ...legacyPlatformNativeShape("youtube"),
    intent: "video_post",
    ...over,
  };
}

describe("youtubeAdapter — capabilities", () => {
  it("video_post / new_post (community) / short_video / unknown", () => {
    const c = youtubeAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("video_post")).toBe(true);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("short_video")).toBe(true);
  });
});

describe("youtubeAdapter — video_post", () => {
  it("happy path → format=video_post, routing carries title + thumbnail", () => {
    const p = youtubeAdapter.buildPreview(input());
    expect(p.format).toBe("video_post");
    expect(p.blockers).toEqual([]);
    expect(p.routing?.video_title).toBe("My video");
    expect(p.routing?.thumbnail_url).toBe("https://example.com/thumb.jpg");
  });

  it("missing title → video_title_required", () => {
    const p = youtubeAdapter.buildPreview(input({ title: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("video_title_required");
  });

  it("title > 100 → youtube_title_exceeds_budget", () => {
    const p = youtubeAdapter.buildPreview(input({ title: "x".repeat(110) }));
    expect(p.blockers.map((b) => b.code)).toContain(
      "youtube_title_exceeds_budget",
    );
  });

  it("missing creative → video_required", () => {
    const p = youtubeAdapter.buildPreview(input({ creative: null }));
    expect(p.blockers.map((b) => b.code)).toContain("video_required");
  });

  it("tags → routing.tags_csv populated", () => {
    const p = youtubeAdapter.buildPreview(
      input({ tags: ["ai", "ts", "publishing"] }),
    );
    expect(p.routing?.tags_csv).toBe("ai,ts,publishing");
  });
});

describe("youtubeAdapter — community post (new_post)", () => {
  it("happy path → format=single_post", () => {
    const p = youtubeAdapter.buildPreview(
      input({ shape: shape({ intent: "new_post" }), title: null }),
    );
    expect(p.format).toBe("single_post");
    expect(p.blockers).toEqual([]);
  });

  it("empty body → empty_body", () => {
    const p = youtubeAdapter.buildPreview(
      input({ shape: shape({ intent: "new_post" }), body: "" }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("empty_body");
  });

  it("body > 5000 → community_post_exceeds_budget", () => {
    const p = youtubeAdapter.buildPreview(
      input({ shape: shape({ intent: "new_post" }), body: "x".repeat(5100) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "community_post_exceeds_budget",
    );
  });
});

describe("youtubeAdapter — reserved", () => {
  it("short_video → format=unknown + warning", () => {
    const p = youtubeAdapter.buildPreview(
      input({ shape: shape({ intent: "short_video" }) }),
    );
    expect(p.format).toBe("unknown");
    expect(p.warnings.some((w) => /reserved/.test(w))).toBe(true);
  });
});
