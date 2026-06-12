import { describe, expect, it } from "vitest";
import {
  effectiveCreativeUrl,
  resolvePublishCreative,
} from "./resolve-publish-creative";
import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";

/**
 * Tests pin the operator-trust contract:
 *
 *   - if no approved creative exists, return "none" (text-only OK)
 *   - if an approved creative has the wire fields (URL + alt), return
 *     "ready" with a `PublishCreative` payload
 *   - if an approved creative is missing URL or alt, return "blocked"
 *     with the appropriate reasonCode so the scheduler doesn't
 *     silently downgrade to text-only
 */

function creative(
  over: Partial<WeeklyPlanItemCreative> = {},
): WeeklyPlanItemCreative {
  return {
    id: "c-1",
    workspaceId: "ws-1",
    weeklyPlanItemId: "pi-1",
    creativeType: "image",
    sourceType: "uploaded",
    sourceUrl: null,
    assetUrl: "https://example.com/image.jpg",
    prompt: null,
    altText: "Description of the image",
    license: null,
    attribution: null,
    riskNotes: null,
    status: "approved",
    metadata: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    ...over,
  } as unknown as WeeklyPlanItemCreative;
}

describe("resolvePublishCreative — no approved creative", () => {
  it("empty list → none", () => {
    expect(resolvePublishCreative([])).toEqual({ kind: "none" });
  });

  it("all creatives non-approved → none (existing text-only behavior preserved)", () => {
    expect(
      resolvePublishCreative([
        creative({ status: "draft" } as never),
        creative({ status: "rejected" } as never),
      ]),
    ).toEqual({ kind: "none" });
  });
});

describe("resolvePublishCreative — approved + valid → ready", () => {
  it("uploaded creative with assetUrl + alt → ready", () => {
    const r = resolvePublishCreative([creative()]);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.creative.id).toBe("c-1");
      expect(r.creative.creativeType).toBe("image");
      expect(r.creative.assetUrl).toBe("https://example.com/image.jpg");
      expect(r.creative.altText).toBe("Description of the image");
    }
  });

  it("threads stored mimeType + sizeBytes so provider-media-prep can size-check", () => {
    const r = resolvePublishCreative([
      creative({ mimeType: "image/png", sizeBytes: 2_070_497 } as never),
    ]);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      // The original row is unchanged; the wire shape simply CARRIES
      // the stored media metadata for the per-platform prep layer.
      expect(r.creative.mimeType).toBe("image/png");
      expect(r.creative.sizeBytes).toBe(2_070_497);
    }
  });

  it("manual_url creative with sourceUrl only → ready (sourceUrl falls back to assetUrl)", () => {
    const r = resolvePublishCreative([
      creative({
        sourceType: "manual_url" as never,
        assetUrl: null,
        sourceUrl: "https://example.com/external.png",
      }),
    ]);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.creative.assetUrl).toBe(null);
      expect(r.creative.sourceUrl).toBe("https://example.com/external.png");
    }
  });

  it("alt text is trimmed", () => {
    const r = resolvePublishCreative([
      creative({ altText: "  Already approved alt  " }),
    ]);
    if (r.kind === "ready") {
      expect(r.creative.altText).toBe("Already approved alt");
    }
  });

  it("picks the first approved creative (multi-image attachments are deferred)", () => {
    const r = resolvePublishCreative([
      creative({ id: "first", altText: "first alt" }),
      creative({ id: "second", altText: "second alt" }),
    ]);
    if (r.kind === "ready") {
      expect(r.creative.id).toBe("first");
    }
  });

  it("skips non-approved entries when picking the primary", () => {
    const r = resolvePublishCreative([
      creative({ id: "draft-one", status: "draft" as never }),
      creative({ id: "approved-two" }),
    ]);
    if (r.kind === "ready") {
      expect(r.creative.id).toBe("approved-two");
    }
  });
});

describe("resolvePublishCreative — approved-but-malformed → blocked", () => {
  it("missing assetUrl AND sourceUrl → creative_missing_asset", () => {
    const r = resolvePublishCreative([
      creative({ assetUrl: null, sourceUrl: null }),
    ]);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.reasonCode).toBe("creative_missing_asset");
      expect(r.reasonDetail).toMatch(/asset_url \/ source_url/i);
      expect(r.creativeId).toBe("c-1");
    }
  });

  it("whitespace-only URL → creative_missing_asset", () => {
    const r = resolvePublishCreative([
      creative({ assetUrl: "   ", sourceUrl: null }),
    ]);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.reasonCode).toBe("creative_missing_asset");
    }
  });

  it("URL present but no alt text → creative_missing_alt_text", () => {
    const r = resolvePublishCreative([creative({ altText: null })]);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.reasonCode).toBe("creative_missing_alt_text");
      expect(r.reasonDetail).toMatch(/alt text/i);
    }
  });

  it("whitespace-only alt text → creative_missing_alt_text", () => {
    const r = resolvePublishCreative([creative({ altText: "   " })]);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.reasonCode).toBe("creative_missing_alt_text");
    }
  });
});

describe("effectiveCreativeUrl", () => {
  it("prefers assetUrl over sourceUrl", () => {
    expect(
      effectiveCreativeUrl({
        id: "x",
        creativeType: "image",
        sourceType: "uploaded",
        assetUrl: "https://example.com/asset.jpg",
        sourceUrl: "https://example.com/source.jpg",
        altText: "a",
      }),
    ).toBe("https://example.com/asset.jpg");
  });

  it("falls back to sourceUrl when assetUrl is null", () => {
    expect(
      effectiveCreativeUrl({
        id: "x",
        creativeType: "image",
        sourceType: "manual_url",
        assetUrl: null,
        sourceUrl: "https://example.com/source.jpg",
        altText: "a",
      }),
    ).toBe("https://example.com/source.jpg");
  });

  it("returns null when both are missing", () => {
    expect(
      effectiveCreativeUrl({
        id: "x",
        creativeType: "image",
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: null,
        altText: "a",
      }),
    ).toBe(null);
  });
});
