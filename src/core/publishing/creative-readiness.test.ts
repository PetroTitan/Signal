import { describe, expect, it } from "vitest";
import {
  assertApprovable,
  creativeSelectionPriority,
  deriveCreativeReadinessState,
  hasRealMediaAsset,
  isCreativeReady,
  selectPrimaryCreative,
  validateAttachInput,
  type CreativeReadinessInput,
  type SelectableCreative,
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

// =====================================================================
// selectPrimaryCreative — read-model "current creative" picker
// =====================================================================

/**
 * Selector regression (audit 2026-05-27): plan_items have MULTIPLE
 * creative rows in production:
 *
 *   1. prepare_item drops a `planned` placeholder (no asset)
 *   2. signal.upload_creative_asset adds the real uploaded row later
 *   3. operators / Codex may upload replacements, leaving earlier
 *      asset-backed rows in place for audit
 *
 * Pre-fix the read tool returned the first row by `created_at ASC`,
 * which kept surfacing the planned placeholder even after a real
 * upload landed. These tests pin the operator-facing rule:
 *
 *   - Asset-backed beats not-asset-backed.
 *   - Among asset-backed: approved > pending_review > asset_ready >
 *     rejected.
 *   - Same-tier ties broken by newest `createdAt`.
 *   - Historical placeholders are not deleted; the selector only
 *     picks the "current" primary.
 */

function selectable(
  id: string,
  createdAt: string,
  over: Partial<CreativeReadinessInput> = {},
): SelectableCreative {
  return {
    id,
    createdAt,
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

describe("creativeSelectionPriority", () => {
  it("returns 0 for no asset (prompt-only)", () => {
    expect(
      creativeSelectionPriority({
        status: "pending_review",
        sourceType: "generated",
        assetUrl: null,
        sourceUrl: null,
        storagePath: null,
        altText: null,
        prompt: "p",
        license: null,
        attribution: null,
      }),
    ).toBe(0);
  });

  it("returns 0 for source_type='planned' placeholder", () => {
    expect(
      creativeSelectionPriority({
        status: "planned",
        sourceType: "planned",
        assetUrl: null,
        sourceUrl: null,
        storagePath: null,
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(0);
  });

  // ---- storage_path-backed tier (12..15) ----

  it("returns 15 for approved + storage_path (canonical workspace upload)", () => {
    expect(
      creativeSelectionPriority({
        status: "approved",
        sourceType: "uploaded",
        assetUrl: "https://cdn.example.com/a.jpg",
        sourceUrl: null,
        storagePath: "ws-1/item-1/a.jpg",
        altText: "alt",
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(15);
  });

  it("returns 14 for pending_review + storage_path", () => {
    expect(
      creativeSelectionPriority({
        status: "pending_review",
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: null,
        storagePath: "ws-1/item-1/a.jpg",
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(14);
  });

  it("returns 13 for planned status + storage_path (derived asset_ready)", () => {
    expect(
      creativeSelectionPriority({
        status: "planned",
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: null,
        storagePath: "ws-1/item-1/a.jpg",
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(13);
  });

  it("returns 12 for rejected + storage_path", () => {
    expect(
      creativeSelectionPriority({
        status: "rejected",
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: null,
        storagePath: "ws-1/item-1/a.jpg",
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(12);
  });

  // ---- asset_url-only tier (8..11): legacy generated / hosted ----

  it("returns 11 for approved + asset_url only (legacy generated, NO storage_path)", () => {
    // Mirrors plan_item 41354be5 row 95695e78: generated/approved
    // with a data: URL asset_url, no storage_path.
    expect(
      creativeSelectionPriority({
        status: "approved",
        sourceType: "generated",
        assetUrl: "data:image/jpeg;base64,/9j/4AAQ...",
        sourceUrl: null,
        storagePath: null,
        altText: "alt",
        prompt: "A landscape photo",
        license: null,
        attribution: null,
      }),
    ).toBe(11);
  });

  it("returns 10 for pending_review + asset_url only", () => {
    expect(
      creativeSelectionPriority({
        status: "pending_review",
        sourceType: "generated",
        assetUrl: "https://gen.example.com/result.png",
        sourceUrl: null,
        storagePath: null,
        altText: null,
        prompt: "p",
        license: null,
        attribution: null,
      }),
    ).toBe(10);
  });

  it("returns 9 for planned status + asset_url only", () => {
    expect(
      creativeSelectionPriority({
        status: "planned",
        sourceType: "generated",
        assetUrl: "https://gen.example.com/result.png",
        sourceUrl: null,
        storagePath: null,
        altText: null,
        prompt: "p",
        license: null,
        attribution: null,
      }),
    ).toBe(9);
  });

  it("returns 8 for rejected + asset_url only", () => {
    expect(
      creativeSelectionPriority({
        status: "rejected",
        sourceType: "generated",
        assetUrl: "https://gen.example.com/result.png",
        sourceUrl: null,
        storagePath: null,
        altText: null,
        prompt: "p",
        license: null,
        attribution: null,
      }),
    ).toBe(8);
  });

  // ---- source_url-only tier (4..7): external / degenerate ----

  it("returns 7 for approved + source_url only (external source)", () => {
    expect(
      creativeSelectionPriority({
        status: "approved",
        sourceType: "wikimedia",
        assetUrl: null,
        sourceUrl: "https://commons.wikimedia.org/foo.jpg",
        storagePath: null,
        altText: "alt",
        license: "CC-BY-4.0",
        attribution: "Photo: Anon",
        prompt: null,
      }),
    ).toBe(7);
  });

  it("returns 6 for pending_review + source_url only (degenerate uploaded re-attach)", () => {
    expect(
      creativeSelectionPriority({
        status: "pending_review",
        sourceType: "uploaded",
        assetUrl: null,
        sourceUrl: "https://example.com/img.png",
        storagePath: null,
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(6);
  });

  it("returns 5 for planned status + source_url only", () => {
    expect(
      creativeSelectionPriority({
        status: "planned",
        sourceType: "manual_url",
        assetUrl: null,
        sourceUrl: "https://example.com/img.png",
        storagePath: null,
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(5);
  });

  it("returns 4 for rejected + source_url only", () => {
    expect(
      creativeSelectionPriority({
        status: "rejected",
        sourceType: "manual_url",
        assetUrl: null,
        sourceUrl: "https://example.com/img.png",
        storagePath: null,
        altText: null,
        prompt: null,
        license: null,
        attribution: null,
      }),
    ).toBe(4);
  });

  // ---- presence-dominates-status cross-tier checks ----

  it("storage_path tier (any status) always outranks asset_url-only tier (any status)", () => {
    // Pins the key structural rule. rejected+storage_path (12) >
    // approved+asset_url-only (11).
    const rejectedStorage = creativeSelectionPriority({
      status: "rejected",
      sourceType: "uploaded",
      assetUrl: null,
      sourceUrl: null,
      storagePath: "ws-1/item-1/a.jpg",
      altText: null,
      prompt: null,
      license: null,
      attribution: null,
    });
    const approvedAssetUrlOnly = creativeSelectionPriority({
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,abc",
      sourceUrl: null,
      storagePath: null,
      altText: "alt",
      prompt: "p",
      license: null,
      attribution: null,
    });
    expect(rejectedStorage).toBeGreaterThan(approvedAssetUrlOnly);
  });

  it("asset_url-only tier (any status) always outranks source_url-only tier (any status)", () => {
    const rejectedAssetUrl = creativeSelectionPriority({
      status: "rejected",
      sourceType: "generated",
      assetUrl: "https://gen.example.com/r.png",
      sourceUrl: null,
      storagePath: null,
      altText: null,
      prompt: "p",
      license: null,
      attribution: null,
    });
    const approvedSourceUrl = creativeSelectionPriority({
      status: "approved",
      sourceType: "wikimedia",
      assetUrl: null,
      sourceUrl: "https://commons.wikimedia.org/foo.jpg",
      storagePath: null,
      altText: "alt",
      license: "CC-BY-4.0",
      attribution: "Photo: Anon",
      prompt: null,
    });
    expect(rejectedAssetUrl).toBeGreaterThan(approvedSourceUrl);
  });
});

describe("selectPrimaryCreative", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectPrimaryCreative([])).toBeNull();
  });

  it("returns the only candidate when the list has length 1", () => {
    const only = selectable("only", "2026-05-27T13:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    expect(selectPrimaryCreative([only])?.id).toBe("only");
  });

  it("REGRESSION: planned placeholder + uploaded asset-backed → uploaded wins", () => {
    // Mirrors the production state pre-fix: the older planned row
    // would have been returned first by created_at ASC.
    const planned = selectable("planned-1", "2026-05-27T12:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    const uploaded = selectable("uploaded-1", "2026-05-27T13:07:19Z", {
      status: "pending_review",
      sourceType: "uploaded",
      storagePath: "ws-1/item-1/a.jpg",
      assetUrl: "https://cdn.example.com/a.jpg",
      altText: "alt",
    });
    expect(selectPrimaryCreative([planned, uploaded])?.id).toBe("uploaded-1");
    // Order-independent.
    expect(selectPrimaryCreative([uploaded, planned])?.id).toBe("uploaded-1");
  });

  it("approved asset-backed beats pending_review asset-backed even when older", () => {
    const olderApproved = selectable("approved-1", "2026-05-27T12:00:00Z", {
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/older.jpg",
      altText: "alt",
    });
    const newerPending = selectable("pending-1", "2026-05-27T13:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/newer.jpg",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([olderApproved, newerPending])?.id,
    ).toBe("approved-1");
  });

  it("REGRESSION: among multiple pending_review storage-backed, newest createdAt wins", () => {
    // Mirrors the 3-row production case for plan_item 1d3bbee2 (X):
    //   109681bd (13:04:18) — storage-backed (asset_url + storage_path)
    //   72c7fa8e (13:07:19) — storage-backed (the operator's expected winner)
    //   22ac2674 (13:08:29) — source_url ONLY (degenerate re-attach, same
    //                          underlying file as 72c7fa8e but missing the
    //                          storage_path / asset_url that mark the
    //                          canonical uploaded row)
    // 72c7fa8e must beat 109681bd (same combined tier, newer) AND
    // 22ac2674 (storage-backed > source_url-only at the same status tier
    // regardless of recency).
    const older = selectable("109681bd", "2026-05-27T13:04:18Z", {
      status: "pending_review",
      sourceType: "uploaded",
      storagePath: "ws-1/item-1/older.png",
      assetUrl: "https://cdn.example.com/older.png",
      altText: "alt",
    });
    const expectedWinner = selectable("72c7fa8e", "2026-05-27T13:07:19Z", {
      status: "pending_review",
      sourceType: "uploaded",
      storagePath: "ws-1/item-1/winner.png",
      assetUrl: "https://cdn.example.com/winner.png",
      altText: "alt",
    });
    const newestSourceUrlOnly = selectable("22ac2674", "2026-05-27T13:08:29Z", {
      status: "pending_review",
      sourceType: "uploaded",
      // Degenerate row: only source_url set, pointing to the same file
      // as 72c7fa8e but missing the canonical storage_path / asset_url.
      sourceUrl: "https://cdn.example.com/winner.png",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([older, expectedWinner, newestSourceUrlOnly])?.id,
    ).toBe("72c7fa8e");
  });

  it("storage-backed beats source-url-only at the same status tier even when older", () => {
    // Pins the sub-tier rule: storage-backed (storage_path or
    // asset_url) outranks source-url-only within the same status tier.
    const olderStorage = selectable("storage-1", "2026-05-27T12:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      storagePath: "ws-1/item-1/a.jpg",
      assetUrl: "https://cdn.example.com/a.jpg",
      altText: "alt",
    });
    const newerSourceUrlOnly = selectable("source-1", "2026-05-27T13:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      sourceUrl: "https://cdn.example.com/a.jpg",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([olderStorage, newerSourceUrlOnly])?.id,
    ).toBe("storage-1");
  });

  it("rejected asset-backed is ranked BELOW any other asset-backed row", () => {
    const rejected = selectable("rejected-1", "2026-05-27T14:00:00Z", {
      status: "rejected",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/rejected.jpg",
      altText: "alt",
    });
    const olderPending = selectable("pending-1", "2026-05-27T12:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/pending.jpg",
      altText: "alt",
    });
    expect(selectPrimaryCreative([rejected, olderPending])?.id).toBe("pending-1");
  });

  it("rejected asset-backed is still selectable when nothing else exists", () => {
    const rejected = selectable("rejected-1", "2026-05-27T14:00:00Z", {
      status: "rejected",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/rejected.jpg",
      altText: "alt",
    });
    expect(selectPrimaryCreative([rejected])?.id).toBe("rejected-1");
  });

  it("planned placeholder is only selected when NO asset-backed exists", () => {
    const planned = selectable("planned-1", "2026-05-27T12:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    expect(selectPrimaryCreative([planned])?.id).toBe("planned-1");
  });

  it("does NOT treat prompt / metadata / aspect_ratio / alt text as proof of asset", () => {
    // Source-of-truth rule: presence comes from persisted columns only.
    const promptOnlyButRich = selectable(
      "prompt-only",
      "2026-05-27T14:00:00Z",
      {
        status: "pending_review",
        sourceType: "generated",
        prompt: "A wide-angle shot of a mountain at dawn",
        altText: "Mountain at dawn",
        license: "CC-BY-4.0",
        attribution: "Photo: Anon",
      },
    );
    const earlierUpload = selectable("real", "2026-05-27T13:00:00Z", {
      status: "planned",
      sourceType: "uploaded",
      storagePath: "ws-1/item-1/real.jpg",
    });
    // earlierUpload (asset_ready, tier 2) beats promptOnly (tier 0)
    // even though promptOnly is newer.
    expect(
      selectPrimaryCreative([promptOnlyButRich, earlierUpload])?.id,
    ).toBe("real");
  });

  it("preserves historical placeholders (selector picks one — never mutates the list)", () => {
    const planned = selectable("planned-1", "2026-05-27T12:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    const uploaded = selectable("uploaded-1", "2026-05-27T13:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.jpg",
      altText: "alt",
    });
    const candidates = [planned, uploaded] as const;
    selectPrimaryCreative(candidates);
    // Caller's array intact, both rows still present — no deletion.
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("planned-1");
    expect(candidates[1].id).toBe("uploaded-1");
  });

  // -------------------------------------------------------------------
  // Bluesky edge case (plan_item 41354be5): a legacy
  // generated/approved row with a base64 `data:` asset_url (no
  // storage_path) was beating the newer uploaded/pending_review row
  // with a real workspace storage_path. Presence must dominate status.
  // -------------------------------------------------------------------

  it("REGRESSION: generated/approved with data: asset_url (no storage_path) loses to uploaded/pending_review with storage_path", () => {
    // Mirrors plan_item 41354be5 verbatim:
    //   95695e78 (older, 2026-05-26 12:33) — generated/approved,
    //     asset_url = data:image/jpeg;base64,..., no storage_path.
    //   dc03ca25 (newer, 2026-05-27 13:43) — uploaded/pending_review,
    //     asset_url = Supabase public URL, storage_path present.
    // Expected: dc03ca25 wins because storage_path tier dominates
    // status — even though the legacy row is "approved" it has no
    // canonical workspace storage backing.
    const legacyApproved = selectable("95695e78", "2026-05-26T12:33:07Z", {
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
      prompt: "A landscape photo",
      altText: "alt",
    });
    const newUpload = selectable("dc03ca25", "2026-05-27T13:43:12Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl:
        "https://kcaxqzbnrxzqisewbdkf.supabase.co/storage/v1/object/public/weekly-plan-creatives/3ae3ff71/41354be5/dde690.png",
      storagePath: "3ae3ff71/41354be5/dde690.png",
      altText: "alt",
      prompt: "A landscape photo",
    });
    expect(
      selectPrimaryCreative([legacyApproved, newUpload])?.id,
    ).toBe("dc03ca25");
    // Order-independent.
    expect(
      selectPrimaryCreative([newUpload, legacyApproved])?.id,
    ).toBe("dc03ca25");
  });

  it("REGRESSION: uploaded/pending_review with storage_path beats source_url-only generated/approved", () => {
    // A `generated/approved` row that only has source_url (no
    // storage_path, no asset_url) is even more degenerate than the
    // data-URL case — it sits in the source_url-only presence tier
    // and must lose to any storage-backed uploaded row.
    const legacySourceUrlOnly = selectable("legacy-1", "2026-05-26T12:00:00Z", {
      status: "approved",
      sourceType: "generated",
      sourceUrl: "https://gen.example.com/r.png",
      prompt: "p",
      altText: "alt",
    });
    const newUpload = selectable("upload-1", "2026-05-27T13:43:12Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.png",
      storagePath: "ws-1/item-1/a.png",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([legacySourceUrlOnly, newUpload])?.id,
    ).toBe("upload-1");
  });

  it("approved uploaded with storage_path still wins over pending_review uploaded with storage_path", () => {
    // Within the storage-backed presence tier, status still wins.
    // Normal happy path: approved beats pending_review.
    const olderApproved = selectable("approved-1", "2026-05-27T12:00:00Z", {
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/older.jpg",
      storagePath: "ws-1/item-1/older.jpg",
      altText: "alt",
    });
    const newerPending = selectable("pending-1", "2026-05-27T13:00:00Z", {
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/newer.jpg",
      storagePath: "ws-1/item-1/newer.jpg",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([olderApproved, newerPending])?.id,
    ).toBe("approved-1");
  });

  it("existing normal approved uploaded creative is still selected (no regression)", () => {
    // The simplest happy path: one approved uploaded creative with
    // the canonical storage tuple alongside a planned placeholder.
    // The uploaded creative wins as before.
    const planned = selectable("planned-1", "2026-05-27T12:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    const approvedUpload = selectable("upload-1", "2026-05-27T13:00:00Z", {
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.jpg",
      storagePath: "ws-1/item-1/a.jpg",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([planned, approvedUpload])?.id,
    ).toBe("upload-1");
  });

  it("planned placeholders still lose to asset-backed creatives (incl. legacy data: URL rows)", () => {
    // Sanity: even the most degenerate asset-backed row (data: URL
    // with no storage_path) outranks the prompt-only placeholder.
    const planned = selectable("planned-1", "2026-05-27T12:00:00Z", {
      status: "planned",
      sourceType: "planned",
    });
    const legacyDataUrl = selectable("legacy-1", "2026-05-27T13:00:00Z", {
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,/9j/4AAQ...",
      prompt: "p",
      altText: "alt",
    });
    expect(
      selectPrimaryCreative([planned, legacyDataUrl])?.id,
    ).toBe("legacy-1");
  });
});
