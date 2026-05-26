import { describe, expect, it } from "vitest";
import { linkedinAdapter } from "./index";
import {
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "A short LinkedIn post.",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: legacyPlatformNativeShape("linkedin"),
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("linkedin"), ...over };
}

describe("linkedinAdapter — capabilities", () => {
  it("supports new_post / article / media_post / link_post", () => {
    const c = linkedinAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("article")).toBe(true);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.supportedIntents.has("link_post")).toBe(true);
    expect(c.reply.supported).toBe(false);
    expect(c.quote.supported).toBe(false);
  });
});

describe("linkedinAdapter — feed post (new_post)", () => {
  it("short body → single_post, no blocker", () => {
    const p = linkedinAdapter.buildPreview(input({ shape: shape({ intent: "new_post" }) }));
    expect(p.format).toBe("single_post");
    expect(p.blockers).toEqual([]);
  });

  it("body > 3000 chars → linkedin_post_exceeds_budget (no silent truncation)", () => {
    const p = linkedinAdapter.buildPreview(
      input({ body: "x".repeat(3100), shape: shape({ intent: "new_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "linkedin_post_exceeds_budget",
    );
  });

  it("body > 1300 chars → 'see more' warning", () => {
    const p = linkedinAdapter.buildPreview(
      input({ body: "x".repeat(1500), shape: shape({ intent: "new_post" }) }),
    );
    expect(p.warnings.some((w) => /see more/.test(w))).toBe(true);
  });
});

describe("linkedinAdapter — article", () => {
  it("article without title → article_title_required", () => {
    const p = linkedinAdapter.buildPreview(input({ shape: shape({ intent: "article" }) }));
    expect(p.blockers.map((b) => b.code)).toContain("article_title_required");
  });

  it("article with title + body → format=article, routing carries title", () => {
    const p = linkedinAdapter.buildPreview(
      input({
        title: "An article",
        body: "real body",
        shape: shape({ intent: "article" }),
      }),
    );
    expect(p.format).toBe("article");
    expect(p.routing?.article_title).toBe("An article");
    expect(p.blockers).toEqual([]);
  });
});

describe("linkedinAdapter — link_post", () => {
  it("link_post without linkUrl → link_required_for_link_post", () => {
    const p = linkedinAdapter.buildPreview(input({ shape: shape({ intent: "link_post" }) }));
    expect(p.blockers.map((b) => b.code)).toContain(
      "link_required_for_link_post",
    );
  });
});

describe("linkedinAdapter — media_post", () => {
  it("media_post without creative → media_required_for_media_post", () => {
    const p = linkedinAdapter.buildPreview(input({ shape: shape({ intent: "media_post" }) }));
    expect(p.blockers.map((b) => b.code)).toContain(
      "media_required_for_media_post",
    );
  });
});
