import { describe, expect, it } from "vitest";
import { renderBlueskyPreview } from "./bluesky-preview";
import type { PreviewInput } from "./preview-types";

function makeInput(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    platform: "bluesky",
    title: null,
    body: "",
    identity: {
      displayName: "Op",
      handle: "op.bsky.social",
      avatarUrl: null,
    },
    creative: null,
    ...overrides,
  };
}

describe("renderBlueskyPreview — single post", () => {
  it("renders a short body as a single part", () => {
    const r = renderBlueskyPreview(
      makeInput({ body: "We shipped a queue retry fix today." }),
    );
    expect(r.parts).toHaveLength(1);
    expect(r.format).toBe("single_post");
    expect(r.parts[0].text).toBe("We shipped a queue retry fix today.");
    expect(r.parts[0].budget).toBe(300);
    expect(r.titleVisible).toBe(false);
  });

  it("never fabricates engagement metrics or timestamps", () => {
    const r = renderBlueskyPreview(makeInput({ body: "hi" }));
    expect(r).not.toHaveProperty("likes");
    expect(r).not.toHaveProperty("reposts");
    expect(r).not.toHaveProperty("replies");
    expect(r).not.toHaveProperty("timestamp");
  });
});

describe("renderBlueskyPreview — thread split", () => {
  it("splits long bodies into thread parts at sentence boundaries", () => {
    const body =
      "Lots of small queue fixes shipped this week. The biggest improvement was switching to exponential backoff with jitter. The previous fixed-delay strategy caused thundering-herd retries when a downstream went slow. We measured a 40% drop in 99p latency during the next incident. Next quarter: smarter dead-lettering and a circuit-breaker layer.";
    const r = renderBlueskyPreview(makeInput({ body }));
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.parts[0].total).toBe(r.parts.length);
    expect(r.format).toBe("thread");
    // Each part fits.
    for (const p of r.parts) {
      expect(p.length).toBeLessThanOrEqual(300);
    }
  });

  it("attaches creative only to the first part of a thread", () => {
    const body = "a. ".repeat(200);
    const r = renderBlueskyPreview(
      makeInput({
        body,
        creative: { assetUrl: "https://x/y.png", altText: "x", sourceType: "uploaded" },
      }),
    );
    expect(r.parts[0].showsCreative).toBe(true);
    for (let i = 1; i < r.parts.length; i++) {
      expect(r.parts[i].showsCreative).toBe(false);
    }
  });

  it("flags threads over 8 parts as desperate", () => {
    const sentences = "We shipped a fix. ".repeat(300);
    const r = renderBlueskyPreview(makeInput({ body: sentences }));
    if (r.parts.length > 8) {
      expect(r.warnings.some((w) => w.kind === "thread_too_long")).toBe(true);
    }
  });
});

describe("renderBlueskyPreview — warnings", () => {
  it("warns when the operator supplied a title (Bluesky ignores it)", () => {
    const r = renderBlueskyPreview(
      makeInput({ title: "My headline", body: "Hi." }),
    );
    expect(
      r.warnings.some((w) => w.kind === "title_ignored_by_platform"),
    ).toBe(true);
  });

  it("warns on high hashtag density", () => {
    const r = renderBlueskyPreview(
      makeInput({ body: "hi #a #b #c #d #e #f" }),
    );
    expect(r.warnings.some((w) => w.kind === "high_hashtag_density")).toBe(
      true,
    );
  });

  it("warns on promotional phrasing", () => {
    const r = renderBlueskyPreview(
      makeInput({ body: "This is huge news — must read." }),
    );
    expect(r.warnings.some((w) => w.kind === "too_promotional")).toBe(true);
  });

  it("warns when an image has no alt text", () => {
    const r = renderBlueskyPreview(
      makeInput({
        body: "hi",
        creative: {
          assetUrl: "https://x/y.png",
          altText: "",
          sourceType: "uploaded",
        },
      }),
    );
    expect(r.warnings.some((w) => w.kind === "alt_text_missing")).toBe(true);
  });
});

describe("renderBlueskyPreview — markdown stripping", () => {
  it("strips bold/italic/heading markup", () => {
    const r = renderBlueskyPreview(
      makeInput({ body: "# Heading\n\n**bold** and *italic* text." }),
    );
    expect(r.parts[0].text).not.toMatch(/[*#]/);
  });

  it("notes the transformation", () => {
    const r = renderBlueskyPreview(
      makeInput({ body: "# Title\nbody" }),
    );
    expect(
      r.transformationNotes.some((n) => /markdown/i.test(n)),
    ).toBe(true);
  });
});

describe("renderBlueskyPreview — determinism", () => {
  it("two identical inputs produce identical outputs", () => {
    const input = makeInput({
      body: "Lots of small queue fixes shipped this week. " +
        "The biggest improvement was switching to exponential backoff with jitter. " +
        "We measured a 40% drop in 99p latency.",
    });
    const a = renderBlueskyPreview(input);
    const b = renderBlueskyPreview(input);
    expect(a).toEqual(b);
  });
});
