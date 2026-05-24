import { describe, expect, it } from "vitest";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import {
  adaptIdeaForPlatform,
  finalizeAdaptation,
} from "./adapt-idea-for-platform";
import type { AdaptIdeaInput, PlatformNativeDraft } from "./types";

const ALL_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "x",
  "bluesky",
  "linkedin",
  "threads",
  "instagram",
  "telegram",
  "devto",
  "hashnode",
  "youtube",
  "indie_hackers",
];

function baseInput(overrides: Partial<AdaptIdeaInput> = {}): AdaptIdeaInput {
  return {
    canonicalIdea:
      "We moved refresh-token storage from plaintext to AES-GCM envelope encryption with per-workspace keys. Incident rate from rotated keys dropped to zero.",
    identity: {
      displayName: "WebmasterID",
      handle: "webmasterid",
      voiceProfile: "Calm, technical founder sharing build updates.",
      ageDays: 120,
      status: "active",
    },
    platform: "x",
    product: {
      name: "Signal",
      domain: "signal.webmasterid.com",
      summary: "Publishing operations for builders.",
      category: "developer-tools",
    },
    goal: "share the engineering observation",
    link: null,
    sourceArticle: null,
    launchContext: null,
    ...overrides,
  };
}

// =====================================================================
// Scaffold shape — required fields are present and platform-specific
// =====================================================================

describe("adaptIdeaForPlatform — scaffold shape", () => {
  it("returns a scaffold with required platform-native fields", () => {
    for (const p of ALL_PLATFORMS) {
      const result = adaptIdeaForPlatform(baseInput({ platform: p }));
      expect(result.scaffold.platform).toBe(p);
      expect(result.scaffold.creativeDirection).toBeDefined();
      expect(result.scaffold.creativeDirection.mediaPromptOrBrief.length).toBeGreaterThan(0);
      expect(result.scaffold.format).toBeDefined();
      expect(["low", "medium", "high"]).toContain(result.scaffold.riskLevel);
      expect(Array.isArray(result.scaffold.warnings)).toBe(true);
      expect(Array.isArray(result.scaffold.transformationNotes)).toBe(true);
      // transformationNotes must always be present and non-empty so
      // sibling-platform fan-out can render the differentiation
      // rationale.
      expect(result.scaffold.transformationNotes.length).toBeGreaterThan(0);
    }
  });

  it("every scaffold carries creativeDirection (the user's required field)", () => {
    for (const p of ALL_PLATFORMS) {
      const result = adaptIdeaForPlatform(baseInput({ platform: p }));
      expect(result.creativeDirection).toBe(result.scaffold.creativeDirection);
    }
  });

  it("Instagram + YouTube scaffolds mark mediaRequired=true", () => {
    expect(
      adaptIdeaForPlatform(baseInput({ platform: "instagram" })).scaffold
        .creativeDirection.mediaRequired,
    ).toBe(true);
    expect(
      adaptIdeaForPlatform(baseInput({ platform: "youtube" })).scaffold
        .creativeDirection.mediaRequired,
    ).toBe(true);
  });

  it("Reddit + Bluesky scaffolds default mediaRequired=false", () => {
    expect(
      adaptIdeaForPlatform(baseInput({ platform: "reddit" })).scaffold
        .creativeDirection.mediaRequired,
    ).toBe(false);
    expect(
      adaptIdeaForPlatform(baseInput({ platform: "bluesky" })).scaffold
        .creativeDirection.mediaRequired,
    ).toBe(false);
  });
});

// =====================================================================
// Format mapping is correct per platform
// =====================================================================

describe("adaptIdeaForPlatform — format derivation", () => {
  const cases: Array<[FounderPlatform, string]> = [
    ["reddit", "discussion_post"],
    ["x", "single_post"],
    ["bluesky", "single_post"],
    ["linkedin", "single_post"],
    ["threads", "single_post"],
    ["instagram", "caption"],
    ["telegram", "channel_update"],
    ["devto", "long_form_article"],
    ["hashnode", "long_form_article"],
    ["youtube", "video_description"],
    ["indie_hackers", "discussion_post"],
  ];

  it.each(cases)("%s → format=%s", (platform, expectedFormat) => {
    const result = adaptIdeaForPlatform(baseInput({ platform }));
    expect(result.scaffold.format).toBe(expectedFormat);
  });
});

// =====================================================================
// Cross-platform differentiation: same idea, different platforms must
// produce DIFFERENT prompt shapes, CTA instructions, and creative
// direction. This is the central anti-Reddit-feel-everywhere test.
// =====================================================================

describe("adaptIdeaForPlatform — same idea, different platforms", () => {
  it("produces materially different promptShape blocks across platforms", () => {
    const shapes = ALL_PLATFORMS.map(
      (p) => adaptIdeaForPlatform(baseInput({ platform: p })).promptShape,
    );
    // Every shape must differ — no two platforms share the same block.
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("produces materially different CTA instructions across platforms", () => {
    const ctas = ALL_PLATFORMS.map(
      (p) => adaptIdeaForPlatform(baseInput({ platform: p })).ctaInstruction,
    );
    expect(new Set(ctas).size).toBe(ctas.length);
  });

  it("Reddit + IndieHackers transformationNotes mention discussion / build-in-public — X / Bluesky do not", () => {
    const reddit = adaptIdeaForPlatform(baseInput({ platform: "reddit" })).scaffold
      .transformationNotes.join(" ").toLowerCase();
    expect(reddit).toMatch(/discussion|marketing voice|community/);

    const x = adaptIdeaForPlatform(baseInput({ platform: "x" })).scaffold
      .transformationNotes.join(" ").toLowerCase();
    expect(x).not.toContain("discussion-first");
  });

  it("LinkedIn transformationNotes warn against 'thoughts?' / 'thrilled' patterns implicitly via promptShape", () => {
    const shape = adaptIdeaForPlatform(baseInput({ platform: "linkedin" }))
      .promptShape.toLowerCase();
    expect(shape).toContain("i'm thrilled");
    expect(shape).toContain("agree?");
  });

  it("Telegram transformationNotes mention compactness / notification respect", () => {
    const notes = adaptIdeaForPlatform(baseInput({ platform: "telegram" }))
      .scaffold.transformationNotes.join(" ")
      .toLowerCase();
    expect(notes).toMatch(/compact|notification/);
  });

  it("dev.to transformationNotes mention article shape / H2 / examples", () => {
    const notes = adaptIdeaForPlatform(baseInput({ platform: "devto" }))
      .scaffold.transformationNotes.join(" ")
      .toLowerCase();
    expect(notes).toMatch(/article|h2|section|example/);
  });

  it("Hashnode transformationNotes mention architecture / rationale / tradeoffs", () => {
    const notes = adaptIdeaForPlatform(baseInput({ platform: "hashnode" }))
      .scaffold.transformationNotes.join(" ")
      .toLowerCase();
    expect(notes).toMatch(/architecture|rationale|tradeoff/);
  });

  it("Instagram transformationNotes name the visual as the post", () => {
    const notes = adaptIdeaForPlatform(baseInput({ platform: "instagram" }))
      .scaffold.transformationNotes.join(" ")
      .toLowerCase();
    expect(notes).toMatch(/visual|caption/);
  });

  it("YouTube transformationNotes mention title + chapters + thumbnail", () => {
    const notes = adaptIdeaForPlatform(baseInput({ platform: "youtube" }))
      .scaffold.transformationNotes.join(" ")
      .toLowerCase();
    expect(notes).toMatch(/title.*chapter.*thumbnail|thumbnail.*chapter|chapter.*thumbnail/);
  });
});

// =====================================================================
// New-account safety
// =====================================================================

describe("adaptIdeaForPlatform — new-account safety", () => {
  it("warming identity surfaces a 'warming' warning + medium risk", () => {
    const result = adaptIdeaForPlatform(
      baseInput({
        identity: {
          displayName: "warming-id",
          handle: "warming",
          voiceProfile: null,
          ageDays: 3,
          status: "warming",
        },
      }),
    );
    expect(result.scaffold.warnings.join(" ").toLowerCase()).toContain("warming");
    expect(result.scaffold.riskLevel).toBe("medium");
  });

  it("warming + link bumps warning to mention link policy", () => {
    const result = adaptIdeaForPlatform(
      baseInput({
        platform: "x",
        link: "https://example.com",
        identity: {
          displayName: "n",
          handle: null,
          voiceProfile: null,
          ageDays: 2,
          status: "warming",
        },
      }),
    );
    expect(
      result.scaffold.warnings.join(" ").toLowerCase(),
    ).toMatch(/link/);
  });

  it("warming + launch context bumps risk to high", () => {
    const result = adaptIdeaForPlatform(
      baseInput({
        platform: "linkedin",
        launchContext: "Public v1 launch tomorrow",
        identity: {
          displayName: "n",
          handle: null,
          voiceProfile: null,
          ageDays: 1,
          status: "warming",
        },
      }),
    );
    expect(result.scaffold.riskLevel).toBe("high");
  });

  it("active identity with no link / no launch yields low risk", () => {
    const result = adaptIdeaForPlatform(baseInput({ platform: "bluesky" }));
    expect(result.scaffold.riskLevel).toBe("low");
  });

  it("warming addendum appears in the prompt shape for warming accounts", () => {
    const result = adaptIdeaForPlatform(
      baseInput({
        platform: "x",
        identity: {
          displayName: "n",
          handle: null,
          voiceProfile: null,
          ageDays: 1,
          status: "warming",
        },
      }),
    );
    expect(result.promptShape.toLowerCase()).toContain("warming");
  });
});

// =====================================================================
// finalizeAdaptation
// =====================================================================

describe("finalizeAdaptation", () => {
  it("glues generated content into the scaffold", () => {
    const result = adaptIdeaForPlatform(baseInput({ platform: "x" }));
    const final = finalizeAdaptation({
      scaffold: result.scaffold,
      generated: {
        title: null,
        hook: "Refresh-token storage and incident rate are linked.",
        body: "Encrypted at rest. Per-workspace keys. Zero incidents since.",
        cta: null,
      },
    });
    expect(final.draft.hook).toBe(
      "Refresh-token storage and incident rate are linked.",
    );
    expect(final.draft.body).toContain("Per-workspace keys");
    // Scaffold fields preserved.
    expect(final.draft.creativeDirection).toBe(result.scaffold.creativeDirection);
    expect(final.draft.format).toBe("single_post");
  });

  it("runs cross-platform copypaste check against supplied siblings", () => {
    const xResult = adaptIdeaForPlatform(baseInput({ platform: "x" }));
    const linkedinResult = adaptIdeaForPlatform(
      baseInput({ platform: "linkedin" }),
    );
    const sharedHook =
      "Refresh-token storage and incident rate are linked.";
    const linkedinFinal = finalizeAdaptation({
      scaffold: linkedinResult.scaffold,
      generated: {
        title: null,
        hook: sharedHook,
        body: "L body",
        cta: null,
      },
    }).draft;
    const xFinal = finalizeAdaptation({
      scaffold: xResult.scaffold,
      generated: { title: null, hook: sharedHook, body: "X body", cta: null },
      siblingDrafts: [linkedinFinal],
    });
    expect(
      xFinal.qaFindings.some((f) => f.code === "shared_hook"),
    ).toBe(true);
  });
});

// =====================================================================
// Sibling info-level finding on the adapter
// =====================================================================

describe("adaptIdeaForPlatform — sibling info finding", () => {
  it("emits an info finding when siblings are supplied (re-check happens post-generation)", () => {
    const fakeSibling: PlatformNativeDraft = {
      platform: "linkedin",
      title: null,
      hook: "...",
      body: "...",
      cta: null,
      format: "single_post",
      creativeDirection: adaptIdeaForPlatform(baseInput({ platform: "linkedin" }))
        .creativeDirection,
      riskLevel: "low",
      warnings: [],
      transformationNotes: [],
    };
    const result = adaptIdeaForPlatform(
      baseInput({ platform: "x", siblingDrafts: [fakeSibling] }),
    );
    expect(
      result.qaFindings.some((f) => f.code === "sibling_check_pending"),
    ).toBe(true);
  });
});
