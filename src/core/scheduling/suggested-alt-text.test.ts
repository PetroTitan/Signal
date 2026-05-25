import { describe, expect, it } from "vitest";
import { suggestAltTextFor } from "./suggested-alt-text";

describe("suggestAltTextFor", () => {
  it("uses product + title when both are present (uploaded)", () => {
    const s = suggestAltTextFor({
      title: "Shipped a queue retry fix",
      productName: "WebmasterID",
      sourceType: "uploaded",
      prompt: null,
    });
    expect(s).toBe(
      "WebmasterID screenshot illustrating: Shipped a queue retry fix.",
    );
  });

  it("uses product-only fallback when title missing (uploaded)", () => {
    const s = suggestAltTextFor({
      title: null,
      productName: "WebmasterID",
      sourceType: "uploaded",
      prompt: null,
    });
    expect(s).toMatch(/WebmasterID/);
    expect(s).toMatch(/gradient/);
  });

  it("uses title-only fallback when product missing (uploaded)", () => {
    const s = suggestAltTextFor({
      title: "Shipped a queue retry fix",
      productName: null,
      sourceType: "uploaded",
      prompt: null,
    });
    expect(s).toBe("Image illustrating: Shipped a queue retry fix.");
  });

  it("falls back to generic placeholder when nothing is known", () => {
    const s = suggestAltTextFor({
      title: null,
      productName: null,
      sourceType: null,
      prompt: null,
    });
    expect(s).toMatch(/describe/i);
  });

  it("describes generated images from the prompt", () => {
    const s = suggestAltTextFor({
      title: null,
      productName: null,
      sourceType: "generated",
      prompt: "A founder visual showing two interconnected gears.",
    });
    expect(s).toContain("Generated image showing");
    expect(s).toContain("founder visual");
    expect(s).not.toContain('"');
  });

  it("anchors manual_url images on the title", () => {
    const s = suggestAltTextFor({
      title: "How we batched retries",
      productName: "WebmasterID",
      sourceType: "manual_url",
      prompt: null,
    });
    expect(s).toBe("Image illustrating: How we batched retries.");
  });

  it("never returns an empty string", () => {
    const s = suggestAltTextFor({
      title: null,
      productName: null,
      sourceType: null,
      prompt: null,
    });
    expect(s.length).toBeGreaterThan(0);
  });

  it("is deterministic across calls with the same input", () => {
    const args = {
      title: "x",
      productName: "WebmasterID",
      sourceType: "uploaded",
      prompt: null,
    };
    expect(suggestAltTextFor(args)).toBe(suggestAltTextFor(args));
  });

  it("trims trailing punctuation noise from prompts", () => {
    const s = suggestAltTextFor({
      title: null,
      productName: null,
      sourceType: "generated",
      prompt: "Clean visual of a calm gradient",
    });
    // Leading "Clean" filler should be dropped.
    expect(s).not.toMatch(/Generated image showing Clean/);
  });
});
