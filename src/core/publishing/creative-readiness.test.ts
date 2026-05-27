import { describe, expect, it } from "vitest";
import {
  assertApprovable,
  deriveCreativeReadinessState,
  hasRealMediaAsset,
  isCreativeReady,
  validateAttachInput,
  type CreativeReadinessInput,
} from "./creative-readiness";

/**
 * Pure-helper regression tests.
 *
 * Pins the single source-of-truth rule: creative readiness is
 * derived from persisted columns (asset_url / source_url /
 * storage_path / status / source_type) ONLY. Prompts, metadata,
 * alt text, aspect ratio, license, and attribution are NEVER
 * proof of a real media asset.
 *
 * Production-state regression (audit 2026-05-27): 7 of 9
 * `weekly_plan_item_creatives` rows had `source_type='generated'`
 * + no asset references + `status` in {pending_review, approved}.
 * The post-fix readiness layer must classify these as
 * `needs_action` and the attach validator must refuse them at the
 * MCP boundary.
 */

function input(over: Partial<CreativeReadinessInput> = {}): CreativeReadinessInput {
  return {
    status: "planned",
    sourceType: "planned",
    assetUrl: null,
    sourceUrl: null,
    storagePath: null,
    altText: null,
    prompt: null,
    license: null,
    attribution: null,
    ...over,
  };
}

// =====================================================================
// hasRealMediaAsset — single asset-presence helper
// =====================================================================

describe("hasRealMediaAsset", () => {
  it("returns true when asset_url is set", () => {
    expect(
      hasRealMediaAsset(input({ assetUrl: "https://cdn.example.com/a.jpg" })),
    ).toBe(true);
  });

  it("returns true when source_url is set", () => {
    expect(
      hasRealMediaAsset(
        input({ sourceUrl: "https://commons.wikimedia.org/foo.jpg" }),
      ),
    ).toBe(true);
  });

  it("returns true when storage_path is set (upload pre-signed-URL)", () => {
    expect(
      hasRealMediaAsset(input({ storagePath: "ws-1/creatives/a.jpg" })),
    ).toBe(true);
  });

  it("returns false when all three are null", () => {
    expect(hasRealMediaAsset(input())).toBe(false);
  });

  it("returns false for empty / whitespace-only strings", () => {
    expect(
      hasRealMediaAsset(
        input({ assetUrl: "", sourceUrl: "   ", storagePath: "" }),
      ),
    ).toBe(false);
  });

  it("does NOT infer presence from prompt / alt text / metadata", () => {
    // Source-of-truth rule.
    expect(
      hasRealMediaAsset(
        input({
          prompt: "A wide-angle shot of a mountain at dawn",
          altText: "Mountain at dawn",
          license: "CC-BY-4.0",
          attribution: "Photo: Anon",
        }),
      ),
    ).toBe(false);
  });
});

// =====================================================================
// deriveCreativeReadinessState — derived state model
// =====================================================================

describe("deriveCreativeReadinessState", () => {
  it("rejected wins regardless of asset presence", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "rejected",
          sourceType: "uploaded",
          assetUrl: "https://cdn.example.com/a.jpg",
        }),
      ),
    ).toBe("rejected");
  });

  it("source_type='planned' → planned (placeholder)", () => {
    expect(
      deriveCreativeReadinessState(
        input({ status: "planned", sourceType: "planned" }),
      ),
    ).toBe("planned");
  });

  it("approved + asset present → approved", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "approved",
          sourceType: "uploaded",
          assetUrl: "https://cdn.example.com/a.jpg",
          altText: "alt",
        }),
      ),
    ).toBe("approved");
  });

  it("REGRESSION: approved + NO asset → needs_action (false-ready state)", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "approved",
          sourceType: "generated",
          assetUrl: null,
          sourceUrl: null,
          storagePath: null,
          prompt: "A picture of something",
        }),
      ),
    ).toBe("needs_action");
  });

  it("pending_review + asset present → pending_review", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "pending_review",
          sourceType: "uploaded",
          assetUrl: "https://cdn.example.com/a.jpg",
        }),
      ),
    ).toBe("pending_review");
  });

  it("REGRESSION: pending_review + NO asset → needs_action (the bug the PR fixes)", () => {
    // Mirrors the production state for 7 / 9 audited rows.
    expect(
      deriveCreativeReadinessState(
        input({
          status: "pending_review",
          sourceType: "generated",
          assetUrl: null,
          sourceUrl: null,
          storagePath: null,
          prompt: "A wide-angle shot",
          altText: "Mountain at dawn",
        }),
      ),
    ).toBe("needs_action");
  });

  it("status='planned' + asset present (non-planned source) → asset_ready", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "planned",
          sourceType: "uploaded",
          assetUrl: "https://cdn.example.com/a.jpg",
        }),
      ),
    ).toBe("asset_ready");
  });

  it("status='planned' + storage_path only → asset_ready (upload pre-URL)", () => {
    expect(
      deriveCreativeReadinessState(
        input({
          status: "planned",
          sourceType: "uploaded",
          storagePath: "ws-1/creatives/a.jpg",
        }),
      ),
    ).toBe("asset_ready");
  });
});

// =====================================================================
// isCreativeReady — convenience predicate
// =====================================================================

describe("isCreativeReady", () => {
  it("returns true for asset_ready / pending_review / approved", () => {
    expect(isCreativeReady("asset_ready")).toBe(true);
    expect(isCreativeReady("pending_review")).toBe(true);
    expect(isCreativeReady("approved")).toBe(true);
  });

  it("returns false for planned / generating / rejected / needs_action", () => {
    expect(isCreativeReady("planned")).toBe(false);
    expect(isCreativeReady("generating")).toBe(false);
    expect(isCreativeReady("rejected")).toBe(false);
    expect(isCreativeReady("needs_action")).toBe(false);
  });
});

// =====================================================================
// assertApprovable — approval guard
// =====================================================================

describe("assertApprovable — blocks prompt-only creatives", () => {
  it("REGRESSION: source_type='generated' + no asset + prompt set → creative_missing_asset", () => {
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "generated",
          prompt: "A picture",
          altText: "alt",
        }),
      ),
    ).toBe("creative_missing_asset");
  });

  it("source_type='planned' → creative_only_planned (placeholder)", () => {
    expect(
      assertApprovable(input({ status: "pending_review", sourceType: "planned" })),
    ).toBe("creative_only_planned");
  });

  it("rejected → creative_rejected", () => {
    expect(
      assertApprovable(input({ status: "rejected", sourceType: "uploaded" })),
    ).toBe("creative_rejected");
  });

  it("uploaded + storage_path + alt text → null (approvable)", () => {
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "uploaded",
          storagePath: "ws-1/creatives/a.jpg",
          altText: "Mountain at dawn",
        }),
      ),
    ).toBeNull();
  });

  it("missing alt text → creative_missing_alt_text", () => {
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "uploaded",
          assetUrl: "https://cdn.example.com/a.jpg",
          altText: null,
        }),
      ),
    ).toBe("creative_missing_alt_text");
  });

  it("wikimedia + no license → creative_missing_license_or_attribution", () => {
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "wikimedia",
          sourceUrl: "https://commons.wikimedia.org/foo.jpg",
          altText: "alt",
          license: null,
          attribution: "Photo: Anon",
        }),
      ),
    ).toBe("creative_missing_license_or_attribution");
  });

  it("generated with asset_url but no prompt → creative_missing_prompt", () => {
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "generated",
          assetUrl: "https://cdn.example.com/gen.jpg",
          altText: "alt",
          prompt: null,
        }),
      ),
    ).toBe("creative_missing_prompt");
  });

  it("does NOT treat prompt / metadata / aspect ratio as proof of asset", () => {
    // Even with rich prompt + alt text, no asset = blocked.
    expect(
      assertApprovable(
        input({
          status: "pending_review",
          sourceType: "generated",
          prompt: "A landscape photo, dawn",
          altText: "Mountain at dawn, wide-angle",
        }),
      ),
    ).toBe("creative_missing_asset");
  });
});

// =====================================================================
// validateAttachInput — MCP attach boundary
// =====================================================================

describe("validateAttachInput — prompt-only generated refused at attach", () => {
  it("REGRESSION: source_type='generated' + no asset_url + no source_url → generated_requires_asset_use_planned", () => {
    expect(
      validateAttachInput({
        sourceType: "generated",
        assetUrl: null,
        sourceUrl: null,
        prompt: "A landscape photo",
      }),
    ).toBe("generated_requires_asset_use_planned");
  });

  it("source_type='generated' + asset_url present + prompt → null (allowed)", () => {
    expect(
      validateAttachInput({
        sourceType: "generated",
        assetUrl: "https://cdn.example.com/gen.jpg",
        sourceUrl: null,
        prompt: "A landscape photo",
      }),
    ).toBeNull();
  });

  it("source_type='generated' + source_url present + prompt → null (allowed)", () => {
    expect(
      validateAttachInput({
        sourceType: "generated",
        assetUrl: null,
        sourceUrl: "https://gen.example.com/result",
        prompt: "A landscape photo",
      }),
    ).toBeNull();
  });

  it("source_type='generated' + asset_url + missing prompt → generated_requires_prompt", () => {
    expect(
      validateAttachInput({
        sourceType: "generated",
        assetUrl: "https://cdn.example.com/gen.jpg",
        sourceUrl: null,
        prompt: null,
      }),
    ).toBe("generated_requires_prompt");
  });

  it("source_type='planned' + no asset → null (placeholder is fine)", () => {
    expect(
      validateAttachInput({
        sourceType: "planned",
        assetUrl: null,
        sourceUrl: null,
        prompt: null,
      }),
    ).toBeNull();
  });

  it("source_type='uploaded' + no urls → null (storage_path arrives via upload flow, not attach)", () => {
    expect(
      validateAttachInput({
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: null,
        prompt: null,
      }),
    ).toBeNull();
  });

  it("source_type='wikimedia' + no source_url → external_source_requires_url", () => {
    expect(
      validateAttachInput({
        sourceType: "wikimedia",
        assetUrl: null,
        sourceUrl: null,
        prompt: null,
      }),
    ).toBe("external_source_requires_url");
  });

  it("source_type='manual_url' + source_url present → null", () => {
    expect(
      validateAttachInput({
        sourceType: "manual_url",
        assetUrl: null,
        sourceUrl: "https://example.com/image.jpg",
        prompt: null,
      }),
    ).toBeNull();
  });

  it("whitespace-only urls count as absent for the attach guard", () => {
    expect(
      validateAttachInput({
        sourceType: "generated",
        assetUrl: "   ",
        sourceUrl: "",
        prompt: "p",
      }),
    ).toBe("generated_requires_asset_use_planned");
  });
});

// =====================================================================
// Backward compatibility — existing VALID rows continue to work
// =====================================================================

describe("backward compatibility", () => {
  it("legacy uploaded creative with asset_url + alt text + approved → approvable + state=approved", () => {
    const c = input({
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.jpg",
      altText: "alt",
    });
    expect(assertApprovable(c)).toBeNull();
    expect(deriveCreativeReadinessState(c)).toBe("approved");
    expect(hasRealMediaAsset(c)).toBe(true);
  });

  it("legacy generated creative with real asset_url + prompt + alt text → approvable", () => {
    const c = input({
      status: "pending_review",
      sourceType: "generated",
      assetUrl: "https://cdn.example.com/gen.jpg",
      altText: "Mountain at dawn",
      prompt: "A wide-angle mountain at dawn",
    });
    expect(assertApprovable(c)).toBeNull();
    expect(deriveCreativeReadinessState(c)).toBe("pending_review");
  });

  it("legacy wikimedia creative with license + attribution + alt → approvable", () => {
    const c = input({
      status: "pending_review",
      sourceType: "wikimedia",
      sourceUrl: "https://commons.wikimedia.org/foo.jpg",
      license: "CC-BY-4.0",
      attribution: "Photo: Anon",
      altText: "alt",
    });
    expect(assertApprovable(c)).toBeNull();
  });

  it("legacy planned placeholder remains planned (not promoted by the readiness model)", () => {
    const c = input({ status: "planned", sourceType: "planned" });
    expect(deriveCreativeReadinessState(c)).toBe("planned");
    expect(assertApprovable(c)).toBe("creative_only_planned");
  });
});
