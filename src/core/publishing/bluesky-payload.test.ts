import { describe, expect, it } from "vitest";
import {
  BLUESKY_POST_BUDGET,
  prepareBlueskyThreadPayload,
  validateBlueskyCreative,
  type BlueskyPayloadCreativeInput,
} from "./bluesky-payload";

/**
 * Unit tests for the shared Bluesky payload layer.
 *
 * Preview and publisher both consume this module. Parity tests live
 * in `bluesky-payload.parity.test.ts` and assert the two surfaces
 * produce the same shape for the same input. These tests pin the
 * shared layer's own behavior independent of either caller.
 */

function creative(
  over: Partial<BlueskyPayloadCreativeInput> = {},
): BlueskyPayloadCreativeInput {
  return {
    id: "c-1",
    assetUrl: "https://example.com/image.jpg",
    sourceUrl: null,
    altText: "Alt text describing the image",
    creativeType: "image",
    ...over,
  };
}

// =====================================================================
// validateBlueskyCreative — used by the resolver + the shared layer
// =====================================================================

describe("validateBlueskyCreative", () => {
  it("returns null when creative is absent", () => {
    expect(validateBlueskyCreative(null)).toBe(null);
  });

  it("returns null when creative is fully populated", () => {
    expect(validateBlueskyCreative(creative())).toBe(null);
  });

  it("accepts sourceUrl as fallback for assetUrl", () => {
    expect(
      validateBlueskyCreative(
        creative({ assetUrl: null, sourceUrl: "https://example.com/x.png" }),
      ),
    ).toBe(null);
  });

  it("missing both URLs → creative_missing_asset", () => {
    expect(
      validateBlueskyCreative(creative({ assetUrl: null, sourceUrl: null })),
    ).toEqual({
      reasonCode: "creative_missing_asset",
      reasonDetail: expect.stringMatching(/asset_url \/ source_url/i),
    });
  });

  it("whitespace-only URL → creative_missing_asset", () => {
    expect(
      validateBlueskyCreative(creative({ assetUrl: "   ", sourceUrl: null })),
    ).toEqual({
      reasonCode: "creative_missing_asset",
      reasonDetail: expect.stringMatching(/asset_url \/ source_url/i),
    });
  });

  it("missing alt text → creative_missing_alt_text", () => {
    expect(validateBlueskyCreative(creative({ altText: null }))).toEqual({
      reasonCode: "creative_missing_alt_text",
      reasonDetail: expect.stringMatching(/alt text/i),
    });
  });

  it("whitespace alt text → creative_missing_alt_text", () => {
    expect(validateBlueskyCreative(creative({ altText: "   " }))).toEqual({
      reasonCode: "creative_missing_alt_text",
      reasonDetail: expect.stringMatching(/alt text/i),
    });
  });
});

// =====================================================================
// prepareBlueskyThreadPayload — empty / single / multi-part
// =====================================================================

describe("prepareBlueskyThreadPayload — empty body", () => {
  it("empty string → empty_body", () => {
    expect(prepareBlueskyThreadPayload({ title: null, body: "", creative: null }))
      .toEqual({
        kind: "empty_body",
        reasonDetail: expect.stringMatching(/body/i),
      });
  });

  it("whitespace-only → empty_body", () => {
    expect(
      prepareBlueskyThreadPayload({
        title: null,
        body: "    \n  ",
        creative: null,
      }),
    ).toMatchObject({ kind: "empty_body" });
  });

  it("markdown that strips to nothing → empty_body", () => {
    expect(
      prepareBlueskyThreadPayload({
        title: null,
        body: "```\n```",
        creative: null,
      }),
    ).toMatchObject({ kind: "empty_body" });
  });
});

describe("prepareBlueskyThreadPayload — single post", () => {
  it("short body → single part, no suffix, no truncation", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi there, just a quick note.",
      creative: null,
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].index).toBe(1);
    expect(r.parts[0].total).toBe(1);
    expect(r.parts[0].text).toBe("Hi there, just a quick note.");
    expect(r.parts[0].graphemeCount).toBe(28);
    expect(r.parts[0].attachMedia).toBe(false);
    expect(r.media).toBe(null);
    expect(r.creativeBlocked).toBe(null);
  });

  it("strips markdown and notes the transformation", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "**bold** and *italic* — just text.",
      creative: null,
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts[0].text).not.toMatch(/[*]/);
    expect(r.parts[0].text).toBe("bold and italic — just text.");
    expect(r.transformationNotes).toContain("Stripped Markdown.");
  });

  it("flags title ignored when title is non-empty", () => {
    const r = prepareBlueskyThreadPayload({
      title: "Some title",
      body: "Hi.",
      creative: null,
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.titleIgnored).toBe(true);
    expect(r.transformationNotes).toContain(
      "Title ignored — Bluesky has no post-title concept.",
    );
  });

  it("titleIgnored=false when title is null or empty", () => {
    const empty = prepareBlueskyThreadPayload({
      title: "",
      body: "Hi.",
      creative: null,
    });
    if (empty.kind !== "prepared") throw new Error("expected prepared");
    expect(empty.titleIgnored).toBe(false);

    const nul = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: null,
    });
    if (nul.kind !== "prepared") throw new Error("expected prepared");
    expect(nul.titleIgnored).toBe(false);
  });
});

describe("prepareBlueskyThreadPayload — multi-part thread", () => {
  function longBody(): string {
    return (
      "Sentence one is here. ".repeat(10) +
      "Sentence two with more words is also here for good measure. ".repeat(8) +
      "Final sentence to push past the budget reliably."
    );
  }

  it("body > BLUESKY_POST_BUDGET → multi-part with suffixes", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: longBody(),
      creative: null,
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts.length).toBeGreaterThan(1);
    for (const p of r.parts) {
      expect(p.text).toMatch(new RegExp(`\\(${p.index}/${p.total}\\)$`));
      expect(p.graphemeCount).toBeLessThanOrEqual(BLUESKY_POST_BUDGET);
    }
    expect(r.transformationNotes).toContain(
      `Split into ${r.parts.length} thread parts (Bluesky single-post limit: ${BLUESKY_POST_BUDGET} graphemes).`,
    );
  });

  it("index runs 1..N and total matches parts.length", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: longBody(),
      creative: null,
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    r.parts.forEach((p, i) => {
      expect(p.index).toBe(i + 1);
      expect(p.total).toBe(r.parts.length);
    });
  });

  it("attachMedia is true on part 1 only when creative is valid", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: longBody(),
      creative: creative(),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts[0].attachMedia).toBe(true);
    for (let i = 1; i < r.parts.length; i++) {
      expect(r.parts[i].attachMedia).toBe(false);
    }
    expect(r.media).not.toBe(null);
  });

  it("single-post path still attaches media on part 1 when creative is valid", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Short.",
      creative: creative(),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].attachMedia).toBe(true);
    expect(r.media).not.toBe(null);
  });
});

// =====================================================================
// Creative blocked behavior
// =====================================================================

describe("prepareBlueskyThreadPayload — creative blocked", () => {
  it("missing URL → creativeBlocked=creative_missing_asset, attachMedia=false on all parts", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({ assetUrl: null, sourceUrl: null }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.creativeBlocked?.reasonCode).toBe("creative_missing_asset");
    expect(r.media).toBe(null);
    expect(r.parts[0].attachMedia).toBe(false);
  });

  it("missing alt → creativeBlocked=creative_missing_alt_text, attachMedia=false", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({ altText: "" }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.creativeBlocked?.reasonCode).toBe("creative_missing_alt_text");
    expect(r.media).toBe(null);
    expect(r.parts[0].attachMedia).toBe(false);
  });

  it("blocked creative does NOT prevent text parts from rendering", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "This text should still render even when the image is broken.",
      creative: creative({ altText: "" }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.parts[0].text).toMatch(/render/);
  });
});

// =====================================================================
// Media metadata + structure
// =====================================================================

describe("prepareBlueskyThreadPayload — media metadata", () => {
  it("prefers assetUrl over sourceUrl", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({
        assetUrl: "https://a/asset.jpg",
        sourceUrl: "https://a/source.jpg",
      }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.media?.imageUrl).toBe("https://a/asset.jpg");
  });

  it("falls back to sourceUrl when assetUrl is null", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({
        assetUrl: null,
        sourceUrl: "https://a/source.jpg",
      }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.media?.imageUrl).toBe("https://a/source.jpg");
  });

  it("trims alt text into media.altText", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({ altText: "  trimmed  " }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.media?.altText).toBe("trimmed");
  });

  it("passes through creativeType + creativeId", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({ id: "custom-id", creativeType: "image" }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.media?.creativeId).toBe("custom-id");
    expect(r.media?.creativeType).toBe("image");
  });

  it("accepts a creative with null id (preview surfaces don't track ids)", () => {
    const r = prepareBlueskyThreadPayload({
      title: null,
      body: "Hi.",
      creative: creative({ id: null }),
    });
    if (r.kind !== "prepared") throw new Error("expected prepared");
    expect(r.media?.creativeId).toBe(null);
  });
});

// =====================================================================
// Determinism
// =====================================================================

describe("prepareBlueskyThreadPayload — determinism", () => {
  it("identical inputs produce identical outputs", () => {
    const input = {
      title: "Some title",
      body: "Body. ".repeat(80),
      creative: creative(),
    };
    const a = prepareBlueskyThreadPayload(input);
    const b = prepareBlueskyThreadPayload(input);
    expect(a).toEqual(b);
  });
});
