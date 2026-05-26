import { describe, expect, it } from "vitest";
import { xAdapter } from "./index";
import {
  computeProviderPayloadHash,
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "hello x",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: legacyPlatformNativeShape("x"),
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("x"), ...over };
}

describe("xAdapter — capabilities", () => {
  it("advertises new_post, thread, reply, quote, media_post, repost, unknown", () => {
    const c = xAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("thread")).toBe(true);
    expect(c.supportedIntents.has("reply")).toBe(true);
    expect(c.supportedIntents.has("quote")).toBe(true);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.supportedIntents.has("repost")).toBe(true);
    expect(c.budgets).toEqual({ perPartUnit: "chars", perPartBudget: 280 });
    expect(c.reply.supported).toBe(true);
    expect(c.quote.supported).toBe(true);
  });
});

describe("xAdapter — single post", () => {
  it("short body → single_post, no blockers", () => {
    const p = xAdapter.buildPreview(input());
    expect(p.format).toBe("single_post");
    expect(p.parts).toHaveLength(1);
    expect(p.blockers).toEqual([]);
  });

  it("body exceeds budget + single_only → x_post_exceeds_budget blocker (NO silent split)", () => {
    const longBody = "A. ".repeat(120); // > 280 chars
    const p = xAdapter.buildPreview(
      input({
        body: longBody,
        shape: shape({ intent: "new_post", threadMode: "single_only" }),
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("x_post_exceeds_budget");
  });

  it("body exceeds budget + auto_thread_allowed → thread, no blocker", () => {
    const longBody = "A. ".repeat(120);
    const p = xAdapter.buildPreview(
      input({
        body: longBody,
        shape: shape({ intent: "new_post", threadMode: "auto_thread_allowed" }),
      }),
    );
    expect(p.format).toBe("thread");
    expect(p.parts.length).toBeGreaterThan(1);
    expect(p.blockers.map((b) => b.code)).not.toContain("x_post_exceeds_budget");
  });
});

describe("xAdapter — thread", () => {
  it("intent=thread + body too short → thread_requires_multiple_parts", () => {
    const p = xAdapter.buildPreview(
      input({
        body: "tiny",
        shape: shape({ intent: "thread" }),
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "thread_requires_multiple_parts",
    );
  });

  it("intent=thread + long body → multi-part with (N/M) suffix", () => {
    const longBody = "A. ".repeat(200);
    const p = xAdapter.buildPreview(
      input({
        body: longBody,
        shape: shape({ intent: "thread" }),
      }),
    );
    expect(p.format).toBe("thread");
    expect(p.parts[0].text).toMatch(/\(1\/\d+\)$/);
    expect(p.parts.at(-1)?.text).toMatch(/\(\d+\/\d+\)$/);
    expect(p.routing?.thread_part_count).toBe(String(p.parts.length));
  });
});

describe("xAdapter — reply / quote", () => {
  it("reply without target → reply_target_required", () => {
    const p = xAdapter.buildPreview(
      input({ shape: shape({ intent: "reply" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("reply_target_required");
  });

  it("reply with target → format=reply, routing carries target", () => {
    const p = xAdapter.buildPreview(
      input({
        shape: shape({
          intent: "reply",
          replyTarget: { externalId: "1234567890", url: null },
        }),
      }),
    );
    expect(p.format).toBe("reply");
    expect(p.routing?.reply_to_post_id).toBe("1234567890");
    expect(p.blockers.map((b) => b.code)).not.toContain("reply_target_required");
  });

  it("quote without target → quote_target_required", () => {
    const p = xAdapter.buildPreview(
      input({ shape: shape({ intent: "quote" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("quote_target_required");
  });

  it("quote with URL target → format=quote, routing carries quote URL", () => {
    const p = xAdapter.buildPreview(
      input({
        shape: shape({
          intent: "quote",
          quoteTarget: { externalId: null, url: "https://x.com/u/status/9" },
        }),
      }),
    );
    expect(p.format).toBe("quote");
    expect(p.routing?.quote_url).toBe("https://x.com/u/status/9");
  });
});

describe("xAdapter — media_post", () => {
  it("media_post without creative → media_required", () => {
    const p = xAdapter.buildPreview(
      input({ shape: shape({ intent: "media_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("media_required");
  });

  it("media_post with creative → format=media_post, media on part 1", () => {
    const p = xAdapter.buildPreview(
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
    expect(p.parts[0].media.target).toBe("this_part");
  });
});

describe("xAdapter — payload hash determinism", () => {
  it("identical inputs → identical hash", async () => {
    const a = await computeProviderPayloadHash(xAdapter.buildPreview(input()));
    const b = await computeProviderPayloadHash(xAdapter.buildPreview(input()));
    expect(a).toBe(b);
  });

  it("body change → different hash", async () => {
    const a = await computeProviderPayloadHash(
      xAdapter.buildPreview(input({ body: "first" })),
    );
    const b = await computeProviderPayloadHash(
      xAdapter.buildPreview(input({ body: "second" })),
    );
    expect(a).not.toBe(b);
  });

  it("thread part count change → different hash", async () => {
    const a = await computeProviderPayloadHash(
      xAdapter.buildPreview(
        input({
          body: "A. ".repeat(100),
          shape: shape({ intent: "new_post", threadMode: "auto_thread_allowed" }),
        }),
      ),
    );
    const b = await computeProviderPayloadHash(
      xAdapter.buildPreview(
        input({
          body: "A. ".repeat(200),
          shape: shape({ intent: "new_post", threadMode: "auto_thread_allowed" }),
        }),
      ),
    );
    expect(a).not.toBe(b);
  });
});
