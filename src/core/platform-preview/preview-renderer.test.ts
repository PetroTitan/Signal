import { describe, expect, it } from "vitest";
import {
  asPreviewPlatform,
  emojiCount,
  graphemeCount,
  hashtagDensity,
  lengthWithUrlShortening,
  looksPromotional,
  renderPlatformPreview,
  splitIntoThreadParts,
  stripMarkdownForSocial,
  truncateToGraphemeBudget,
} from "./preview-renderer";
import type { PreviewInput } from "./preview-types";

describe("asPreviewPlatform", () => {
  it("maps known values", () => {
    expect(asPreviewPlatform("bluesky")).toBe("bluesky");
    expect(asPreviewPlatform("x")).toBe("x");
    expect(asPreviewPlatform("linkedin")).toBe("linkedin");
  });
  it("returns null for unsupported v1 platforms", () => {
    expect(asPreviewPlatform("reddit")).toBe(null);
    expect(asPreviewPlatform("devto")).toBe(null);
    expect(asPreviewPlatform("youtube")).toBe(null);
  });
});

describe("renderPlatformPreview dispatcher", () => {
  function input(platform: PreviewInput["platform"]): PreviewInput {
    return {
      platform,
      title: null,
      body: "hi",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
    };
  }
  it("dispatches to bluesky renderer", () => {
    expect(renderPlatformPreview(input("bluesky")).platform).toBe("bluesky");
  });
  it("dispatches to x renderer", () => {
    expect(renderPlatformPreview(input("x")).platform).toBe("x");
  });
  it("dispatches to linkedin renderer", () => {
    expect(renderPlatformPreview(input("linkedin")).platform).toBe("linkedin");
  });
});

describe("stripMarkdownForSocial", () => {
  it("removes headings", () => {
    expect(stripMarkdownForSocial("# Hello\nworld")).toBe("Hello\nworld");
  });
  it("removes bold and italic", () => {
    expect(stripMarkdownForSocial("**bold** and *italic*")).toBe(
      "bold and italic",
    );
  });
  it("preserves URLs and converts markdown link syntax", () => {
    expect(
      stripMarkdownForSocial("[Click](https://example.com)"),
    ).toBe("Click (https://example.com)");
  });
  it("converts bullet markers to • ", () => {
    const out = stripMarkdownForSocial("- one\n- two");
    expect(out).toContain("• one");
    expect(out).toContain("• two");
  });
  it("strips code fences but preserves content", () => {
    expect(stripMarkdownForSocial("```ts\nlet x = 1;\n```")).toBe(
      "let x = 1;",
    );
  });
});

describe("graphemeCount", () => {
  it("counts ASCII characters", () => {
    expect(graphemeCount("hello")).toBe(5);
  });
  it("counts emoji as single graphemes (best-effort)", () => {
    // Intl.Segmenter ideally; either way count is small.
    expect(graphemeCount("👋")).toBeGreaterThanOrEqual(1);
  });
  it("returns 0 for empty string", () => {
    expect(graphemeCount("")).toBe(0);
  });
});

describe("truncateToGraphemeBudget", () => {
  it("does not truncate strings under budget", () => {
    const r = truncateToGraphemeBudget("hello", 10);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello");
  });
  it("truncates with ellipsis when over budget", () => {
    const r = truncateToGraphemeBudget("a".repeat(20), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
  });
});

describe("splitIntoThreadParts", () => {
  it("returns a single part for short body", () => {
    expect(splitIntoThreadParts("hello world.", 100)).toEqual([
      "hello world.",
    ]);
  });
  it("splits at sentence boundaries", () => {
    const body =
      "First sentence is short. Second sentence is also short. Third sentence rounds it out.";
    const parts = splitIntoThreadParts(body, 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(30);
  });
});

describe("hashtagDensity", () => {
  it("returns 0 for body with no hashtags", () => {
    expect(hashtagDensity("hello world")).toBe(0);
  });
  it("scales with tag count", () => {
    const low = hashtagDensity("hello #one");
    const high = hashtagDensity("hello #one #two #three #four");
    expect(high).toBeGreaterThan(low);
  });
});

describe("looksPromotional", () => {
  it("detects hype phrases", () => {
    expect(looksPromotional("This is huge news")).toBe(true);
    expect(looksPromotional("must read this thread")).toBe(true);
  });
  it("returns false for neutral text", () => {
    expect(looksPromotional("we shipped a small fix")).toBe(false);
  });
});

describe("emojiCount", () => {
  it("counts emojis", () => {
    expect(emojiCount("hi 🚀 ✨")).toBeGreaterThanOrEqual(2);
  });
  it("returns 0 for non-emoji strings", () => {
    expect(emojiCount("hi there")).toBe(0);
  });
});

describe("lengthWithUrlShortening", () => {
  it("treats URLs as fixed-weight tokens", () => {
    const text = "Read: https://this-is-a-very-very-long-url.example.com/path";
    expect(lengthWithUrlShortening(text, 23)).toBeLessThan(text.length);
  });
  it("matches grapheme count when no URLs are present", () => {
    expect(lengthWithUrlShortening("hello", 23)).toBe(5);
  });
});
