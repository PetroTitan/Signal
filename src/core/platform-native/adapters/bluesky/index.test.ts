import { describe, expect, it } from "vitest";
import { blueskyAdapter } from "./index";
import { computeProviderPayloadHash } from "../../payload-hash";
import {
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "../../publishing-intent";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "hello bluesky",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: legacyPlatformNativeShape("bluesky"),
    ...over,
  };
}

describe("blueskyAdapter — capabilities matrix", () => {
  it("advertises new_post + thread + unknown, reply/quote NOT supported yet", () => {
    const c = blueskyAdapter.capabilities;
    expect(c.platform).toBe("bluesky");
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("thread")).toBe(true);
    expect(c.supportedIntents.has("unknown")).toBe(true);
    expect(c.supportedIntents.has("reply")).toBe(false);
    expect(c.supportedIntents.has("quote")).toBe(false);
    expect(c.budgets).toEqual({ perPartUnit: "graphemes", perPartBudget: 300 });
    expect(c.reply.supported).toBe(false);
    expect(c.quote.supported).toBe(false);
  });
});

describe("blueskyAdapter.buildPreview — single short post", () => {
  it("returns format=single_post with one part, no media", () => {
    const preview = blueskyAdapter.buildPreview(input());
    expect(preview.platform).toBe("bluesky");
    expect(preview.format).toBe("single_post");
    expect(preview.parts).toHaveLength(1);
    expect(preview.parts[0].text).toBe("hello bluesky");
    expect(preview.parts[0].media.attached).toBe(false);
    expect(preview.blockers).toEqual([]);
  });
});

describe("blueskyAdapter.buildPreview — empty body", () => {
  it("returns format=unknown with an empty_body blocker", () => {
    const preview = blueskyAdapter.buildPreview(input({ body: "   " }));
    expect(preview.format).toBe("unknown");
    expect(preview.parts).toHaveLength(0);
    expect(preview.blockers.map((b) => b.code)).toContain("empty_body");
  });
});

describe("blueskyAdapter.buildPreview — auto-thread when body exceeds budget", () => {
  it("renders format=thread when body forces split", () => {
    const longBody = "A. ".repeat(200); // ~600 chars → >300 graphemes
    const preview = blueskyAdapter.buildPreview(input({ body: longBody }));
    expect(preview.format).toBe("thread");
    expect(preview.parts.length).toBeGreaterThan(1);
  });
});

describe("blueskyAdapter.buildPreview — single_only operator stance is honored", () => {
  it("surfaces single_post_exceeds_budget blocker when split would happen", () => {
    const longBody = "A. ".repeat(200);
    const singleOnly: PlatformNativeShape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
    };
    const preview = blueskyAdapter.buildPreview(
      input({ body: longBody, shape: singleOnly }),
    );
    expect(preview.blockers.map((b) => b.code)).toContain(
      "single_post_exceeds_budget",
    );
  });

  it("no blocker when single_only AND body fits in one post", () => {
    const singleOnly: PlatformNativeShape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
    };
    const preview = blueskyAdapter.buildPreview(
      input({ body: "short", shape: singleOnly }),
    );
    expect(preview.blockers.map((b) => b.code)).not.toContain(
      "single_post_exceeds_budget",
    );
    expect(preview.format).toBe("single_post");
  });
});

describe("blueskyAdapter.buildPreview — creative attaches to part 1", () => {
  it("part 1 carries the embed, alt text propagates", () => {
    const preview = blueskyAdapter.buildPreview(
      input({
        creative: {
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: "A picture",
          creativeType: "image",
        },
      }),
    );
    expect(preview.parts[0].media.attached).toBe(true);
    expect(preview.parts[0].media.target).toBe("this_part");
    expect(preview.parts[0].media.altText).toBe("A picture");
  });

  it("creative without altText → creative_missing_alt_text blocker", () => {
    const preview = blueskyAdapter.buildPreview(
      input({
        creative: {
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: null,
          creativeType: "image",
        },
      }),
    );
    expect(preview.blockers.map((b) => b.code)).toContain(
      "creative_missing_alt_text",
    );
  });
});

describe("blueskyAdapter.validateShape", () => {
  it("legacy shape passes validation", () => {
    const blockers = blueskyAdapter.validateShape(
      legacyPlatformNativeShape("bluesky"),
    );
    expect(blockers).toEqual([]);
  });

  it("reply intent is rejected (not supported in foundation PR)", () => {
    const shape: PlatformNativeShape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "reply",
    };
    const blockers = blueskyAdapter.validateShape(shape);
    expect(blockers.map((b) => b.code)).toContain("intent_not_supported");
  });
});

describe("blueskyAdapter — preview ↔ publish parity", () => {
  it("buildPreview and buildPublishPayload return the same hash for the same input", async () => {
    const i = input();
    const preview = blueskyAdapter.buildPreview(i);
    const publishPayload = blueskyAdapter.buildPublishPayload(i);
    const ph = await computeProviderPayloadHash(preview);
    const wh = await computeProviderPayloadHash(publishPayload);
    expect(ph).toBe(wh);
  });
});
