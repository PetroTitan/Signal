import { describe, expect, it } from "vitest";
import {
  assemblePlatformNativeDraft,
  buildAdaptIdeaInput,
  extractCta,
  extractHook,
} from "./assemble-platform-native-result";
import type {
  GenerationDraft,
  GenerationInput,
} from "./generation-types";
import type { PublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

// =====================================================================
// Fixtures
// =====================================================================

function fakeContext(
  overrides: Partial<PublishingIdentityContext> = {},
): PublishingIdentityContext {
  return {
    identityId: "id-1",
    platform: "x",
    platformLabel: "X",
    displayName: "WebmasterID",
    handle: "webmasterid",
    voiceProfile: "Calm technical founder.",
    ageDays: 120,
    lifecycleStatus: "active",
    associatedProduct: null,
    publishingHistory: [],
    platformGuidance: null,
    ...overrides,
  };
}

function fakeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    weeklyPlanId: null,
    identityId: "id-1",
    platform: "x",
    productId: null,
    topic:
      "We moved refresh-token storage from plaintext to AES-GCM envelope encryption.",
    goal: "share the engineering observation",
    cta: null,
    sourceUrl: null,
    toneAdjustment: null,
    schedulePreference: null,
    ...overrides,
  };
}

function fakeDraft(overrides: Partial<GenerationDraft> = {}): GenerationDraft {
  return {
    title: "Refresh-token storage",
    bodyMarkdown:
      "Refresh-token storage and incident rate are linked.\n\nWe moved to AES-GCM envelope encryption with per-workspace keys.\n\nIncident rate from rotated keys dropped to zero.",
    summary: null,
    tags: [],
    ctaSuggestion: null,
    schedulePreference: null,
    generatedByProvider: true,
    safetyNotes: [],
    ...overrides,
  };
}

// =====================================================================
// extractHook / extractCta
// =====================================================================

describe("extractHook", () => {
  it("returns the first non-heading line of the body", () => {
    expect(extractHook("# Title\n\nFirst sentence.\n\nSecond paragraph.")).toBe(
      "First sentence.",
    );
  });
  it("skips blank lines and code fences", () => {
    expect(extractHook("\n\n```\nfoo\n```\nActual hook.")).toBe("Actual hook.");
  });
  it("returns empty string for empty input", () => {
    expect(extractHook("")).toBe("");
  });
  it("truncates very long hooks at 280 chars", () => {
    const long = "x".repeat(400);
    expect(extractHook(long).length).toBe(280);
  });
});

describe("extractCta", () => {
  it("returns null when the last paragraph is not CTA-shaped", () => {
    expect(extractCta("Plain observation.\n\nAnother paragraph.")).toBeNull();
  });
  it("recognises a CTA ending with ?", () => {
    expect(
      extractCta(
        "Body paragraph one.\n\nHow are you handling this in production?",
      ),
    ).toBe("How are you handling this in production?");
  });
  it("recognises 'curious how' opener", () => {
    expect(
      extractCta("Body.\n\nCurious how others approached the rotation."),
    ).toContain("Curious");
  });
  it("rejects oversized tails (>280 chars)", () => {
    const tail = "x".repeat(400);
    expect(extractCta(`Body.\n\n${tail}?`)).toBeNull();
  });
});

// =====================================================================
// buildAdaptIdeaInput
// =====================================================================

describe("buildAdaptIdeaInput", () => {
  it("maps identity context + generation input into AdaptIdeaInput shape", () => {
    const ctx = fakeContext({
      ageDays: 5,
      lifecycleStatus: "warming",
      associatedProduct: {
        id: "prod-1",
        name: "Signal",
        domain: "signal.webmasterid.com",
        summary: "Publishing operations",
        category: "developer-tools",
      },
    });
    const input = fakeInput({
      sourceUrl: "https://example.com/postmortem",
    });
    const adapt = buildAdaptIdeaInput({
      identityContext: ctx,
      platform: "linkedin",
      generation: input,
    });
    expect(adapt.platform).toBe("linkedin");
    expect(adapt.identity.ageDays).toBe(5);
    expect(adapt.identity.status).toBe("warming");
    expect(adapt.product?.name).toBe("Signal");
    expect(adapt.link).toBe("https://example.com/postmortem");
  });
});

// =====================================================================
// assemblePlatformNativeDraft — end-to-end of the helper
// =====================================================================

describe("assemblePlatformNativeDraft", () => {
  it("returns a complete envelope with every required field", () => {
    const env = assemblePlatformNativeDraft({
      identityContext: fakeContext(),
      platform: "x",
      generation: fakeInput(),
      draft: fakeDraft(),
    });
    expect(env.platform).toBe("x");
    expect(env.creativeDirection).toBeDefined();
    expect(env.creativeDirection.mediaPromptOrBrief.length).toBeGreaterThan(0);
    expect(env.creativeDirection.mediaRiskNotes.length).toBeGreaterThan(0);
    expect(typeof env.creativeDirection.mediaRequired).toBe("boolean");
    expect(env.format).toBe("single_post");
    expect(["low", "medium", "high"]).toContain(env.riskLevel);
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(env.transformationNotes.length).toBeGreaterThan(0);
    expect(env.body).toContain("AES-GCM");
    expect(env.hook).toContain("Refresh-token storage");
  });

  it("Instagram envelope sets mediaRequired=true", () => {
    const env = assemblePlatformNativeDraft({
      identityContext: fakeContext({ platform: "instagram" }),
      platform: "instagram",
      generation: fakeInput({ platform: "instagram" }),
      draft: fakeDraft(),
    });
    expect(env.creativeDirection.mediaRequired).toBe(true);
    expect(env.format).toBe("caption");
  });

  it("YouTube envelope sets mediaRequired=true with thumbnail type", () => {
    const env = assemblePlatformNativeDraft({
      identityContext: fakeContext({ platform: "youtube" }),
      platform: "youtube",
      generation: fakeInput({ platform: "youtube" }),
      draft: fakeDraft(),
    });
    expect(env.creativeDirection.mediaRequired).toBe(true);
    expect(env.creativeDirection.mediaType).toBe("thumbnail");
    expect(env.format).toBe("video_description");
  });

  it("warming identity surfaces a warning + medium risk", () => {
    const env = assemblePlatformNativeDraft({
      identityContext: fakeContext({
        ageDays: 2,
        lifecycleStatus: "warming",
      }),
      platform: "x",
      generation: fakeInput(),
      draft: fakeDraft(),
    });
    expect(env.warnings.join(" ").toLowerCase()).toContain("warming");
    expect(env.riskLevel).toBe("medium");
  });

  it("same canonical idea on different platforms produces different envelopes", () => {
    const platforms: FounderPlatform[] = [
      "reddit",
      "x",
      "bluesky",
      "linkedin",
      "telegram",
      "devto",
      "instagram",
      "youtube",
    ];
    const envelopes = platforms.map((p) =>
      assemblePlatformNativeDraft({
        identityContext: fakeContext({ platform: p }),
        platform: p,
        generation: fakeInput({ platform: p }),
        draft: fakeDraft(),
      }),
    );
    const formats = new Set(envelopes.map((e) => e.format));
    expect(formats.size).toBeGreaterThan(1);
    // Creative direction must differ across platforms — each
    // platform's creative brief is unique.
    const briefs = new Set(
      envelopes.map((e) => e.creativeDirection.mediaPromptOrBrief),
    );
    expect(briefs.size).toBe(envelopes.length);
  });

  it("propagates the generated body + extracted CTA", () => {
    const draft = fakeDraft({
      bodyMarkdown:
        "Hook line goes here.\n\nMore detail.\n\nCurious how others handle this.",
    });
    const env = assemblePlatformNativeDraft({
      identityContext: fakeContext(),
      platform: "x",
      generation: fakeInput(),
      draft,
    });
    expect(env.hook).toBe("Hook line goes here.");
    expect(env.cta).toMatch(/curious/i);
  });
});
