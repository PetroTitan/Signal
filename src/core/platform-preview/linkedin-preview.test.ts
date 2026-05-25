import { describe, expect, it } from "vitest";
import {
  linkedInSeeMoreOffset,
  renderLinkedInPreview,
} from "./linkedin-preview";
import type { PreviewInput } from "./preview-types";

function makeInput(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    platform: "linkedin",
    title: null,
    body: "",
    identity: { displayName: "Op", handle: null, avatarUrl: null },
    creative: null,
    ...overrides,
  };
}

describe("renderLinkedInPreview — basics", () => {
  it("always renders as single_post (no threading on LinkedIn)", () => {
    const r = renderLinkedInPreview(makeInput({ body: "x. ".repeat(800) }));
    expect(r.format).toBe("single_post");
    expect(r.parts).toHaveLength(1);
  });

  it("truncates at the 3000-char hard limit and warns", () => {
    const body = "x".repeat(3500);
    const r = renderLinkedInPreview(makeInput({ body }));
    expect(r.parts[0].truncated).toBe(true);
    expect(r.warnings.some((w) => w.kind === "likely_truncated")).toBe(true);
  });

  it("notes the see-more cutoff when body exceeds 210 chars", () => {
    const r = renderLinkedInPreview(
      makeInput({ body: "x".repeat(400) }),
    );
    expect(
      r.transformationNotes.some((n) => /see more/i.test(n)),
    ).toBe(true);
  });
});

describe("linkedInSeeMoreOffset", () => {
  it("returns null for short posts", () => {
    expect(linkedInSeeMoreOffset("short")).toBe(null);
  });
  it("returns 210 for long posts", () => {
    expect(linkedInSeeMoreOffset("x".repeat(400))).toBe(210);
  });
});

describe("renderLinkedInPreview — warnings", () => {
  it("flags corporate-tone openers", () => {
    const r = renderLinkedInPreview(
      makeInput({ body: "I'm thrilled to announce that we shipped." }),
    );
    expect(r.warnings.some((w) => w.kind === "corporate_tone")).toBe(true);
  });

  it("flags engagement bait closers", () => {
    const r = renderLinkedInPreview(
      makeInput({ body: "We shipped a queue fix. Thoughts?" }),
    );
    expect(r.warnings.some((w) => w.kind === "too_promotional")).toBe(true);
  });

  it("flags external-link-heavy posts", () => {
    const r = renderLinkedInPreview(
      makeInput({
        body:
          "Check these: https://a.example https://b.example https://c.example",
      }),
    );
    expect(r.warnings.some((w) => w.kind === "external_link_heavy")).toBe(
      true,
    );
  });

  it("flags >5 hashtags as keyword stuffing", () => {
    const r = renderLinkedInPreview(
      makeInput({ body: "ship #a #b #c #d #e #f #g" }),
    );
    expect(r.warnings.some((w) => w.kind === "high_hashtag_density")).toBe(
      true,
    );
  });

  it("flags emoji-heavy posts", () => {
    const r = renderLinkedInPreview(
      makeInput({ body: "🚀🎉🔥✨💥 we shipped" }),
    );
    expect(r.warnings.some((w) => w.kind === "emoji_dense")).toBe(true);
  });

  it("warns when title is supplied (LinkedIn doesn't render it)", () => {
    const r = renderLinkedInPreview(
      makeInput({ title: "Headline", body: "x" }),
    );
    expect(
      r.warnings.some((w) => w.kind === "title_ignored_by_platform"),
    ).toBe(true);
  });

  it("warns when alt text missing on attached image", () => {
    const r = renderLinkedInPreview(
      makeInput({
        body: "x",
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

describe("renderLinkedInPreview — never fakes metrics", () => {
  it("result has no reactions / comments / timestamp fields", () => {
    const r = renderLinkedInPreview(makeInput({ body: "hi" }));
    expect(r).not.toHaveProperty("reactions");
    expect(r).not.toHaveProperty("comments");
    expect(r).not.toHaveProperty("timestamp");
  });
});

describe("renderLinkedInPreview — determinism", () => {
  it("two identical inputs produce identical outputs", () => {
    const input = makeInput({ body: "x".repeat(400) });
    expect(renderLinkedInPreview(input)).toEqual(renderLinkedInPreview(input));
  });
});
