import { describe, expect, it } from "vitest";
import { instagramAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "Short caption.",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: {
      assetUrl: "https://example.com/x.jpg",
      sourceUrl: null,
      altText: "alt",
      creativeType: "image",
    },
    shape: {
      ...legacyPlatformNativeShape("instagram"),
      intent: "media_post",
      mediaMode: "first_part_only",
    },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return {
    ...legacyPlatformNativeShape("instagram"),
    intent: "media_post",
    mediaMode: "first_part_only",
    ...over,
  };
}

describe("instagramAdapter — capabilities", () => {
  it("media_post / carousel / story / short_video / unknown", () => {
    const c = instagramAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.supportedIntents.has("carousel")).toBe(true);
    expect(c.supportedIntents.has("story")).toBe(true);
    expect(c.supportedIntents.has("short_video")).toBe(true);
    expect(c.requiresMedia).toBe(true);
  });
});

describe("instagramAdapter — media required", () => {
  it("media_post without creative → media_required", () => {
    const p = instagramAdapter.buildPreview(
      input({ creative: null }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("media_required");
  });

  it("media_post with creative → format=media_post, attached", () => {
    const p = instagramAdapter.buildPreview(input());
    expect(p.format).toBe("media_post");
    expect(p.parts[0].media.attached).toBe(true);
  });

  it("LEGACY (intent=unknown) does NOT trip media_required", () => {
    const p = instagramAdapter.buildPreview(
      input({
        shape: { ...legacyPlatformNativeShape("instagram") },
        creative: null,
      }),
    );
    expect(p.blockers.map((b) => b.code)).not.toContain("media_required");
  });
});

describe("instagramAdapter — caption", () => {
  it("caption > 2200 → caption_exceeds_budget", () => {
    const p = instagramAdapter.buildPreview(input({ body: "x".repeat(2300) }));
    expect(p.blockers.map((b) => b.code)).toContain("caption_exceeds_budget");
  });

  it("caption > 1200 → 'more' warning", () => {
    const p = instagramAdapter.buildPreview(input({ body: "x".repeat(1300) }));
    expect(p.warnings.some((w) => /more/.test(w))).toBe(true);
  });
});

describe("instagramAdapter — carousel", () => {
  it("carousel with expected_part_count<2 → carousel_too_few_items", () => {
    const p = instagramAdapter.buildPreview(
      input({
        shape: shape({ intent: "carousel", expectedPartCount: 1 }),
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("carousel_too_few_items");
  });

  it("carousel with expected_part_count>10 → carousel_too_many_items", () => {
    const p = instagramAdapter.buildPreview(
      input({
        shape: shape({ intent: "carousel", expectedPartCount: 12 }),
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("carousel_too_many_items");
  });

  it("carousel with 4 slides → 4 parts, routing.carousel_count=4", () => {
    const p = instagramAdapter.buildPreview(
      input({
        shape: shape({ intent: "carousel", expectedPartCount: 4 }),
      }),
    );
    expect(p.parts).toHaveLength(4);
    expect(p.routing?.carousel_count).toBe("4");
  });
});

describe("instagramAdapter — reserved intents", () => {
  it("story → warning + format=unknown", () => {
    const p = instagramAdapter.buildPreview(
      input({
        shape: shape({ intent: "story" }),
      }),
    );
    expect(p.format).toBe("unknown");
    expect(p.warnings.some((w) => /reserved/.test(w))).toBe(true);
  });
});
