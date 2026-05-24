import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

// =====================================================================
// Mocks
//
// We mock the I/O boundaries (identity-context loader + provider
// status + provider call). Everything inside generate-draft.ts —
// prompt building, platform-native assembly, safety scanning —
// runs for real. This is the integration shape we want covered:
// the wiring, not the LLM.
// =====================================================================

const getPublishingIdentityContextMock = vi.fn();
const readGenerationProviderStatusMock = vi.fn();
const callGenerationProviderMock = vi.fn();

vi.mock("@/core/publishing/publishing-identity-context", () => ({
  getPublishingIdentityContext: (...args: unknown[]) =>
    getPublishingIdentityContextMock(...args),
}));

vi.mock("./provider-status", () => ({
  readGenerationProviderStatus: () => readGenerationProviderStatusMock(),
}));

vi.mock("./providers", () => ({
  activeProvider: () => "test-provider",
  callGenerationProvider: (call: unknown) => callGenerationProviderMock(call),
}));

import { generateDraft } from "./generate-draft";

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

function input(platform: string) {
  return {
    workspaceId: "ws-1",
    generation: {
      weeklyPlanId: null,
      identityId: "id-1",
      platform,
      productId: null,
      topic:
        "We moved refresh-token storage from plaintext to AES-GCM envelope encryption with per-workspace keys.",
      goal: "share the engineering observation",
      cta: null,
      sourceUrl: null,
      toneAdjustment: null,
      schedulePreference: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

// =====================================================================
// Tests
// =====================================================================

describe("generateDraft — platformNativeDraft envelope is always present", () => {
  it("provider_unavailable path returns a full envelope (no AI body)", async () => {
    getPublishingIdentityContextMock.mockResolvedValue(fakeContext());
    readGenerationProviderStatusMock.mockReturnValue({ available: false });

    const result = await generateDraft(input("x"));

    expect(result.status).toBe("provider_unavailable");
    expect(result.platformNativeDraft).toBeDefined();
    const env = result.platformNativeDraft;
    expect(env.platform).toBe("x");
    expect(env.creativeDirection).toBeDefined();
    expect(env.creativeDirection.mediaPromptOrBrief.length).toBeGreaterThan(0);
    expect(env.transformationNotes.length).toBeGreaterThan(0);
    expect(env.format).toBe("single_post");
  });

  it("identity-missing path still returns a complete envelope (fallback)", async () => {
    getPublishingIdentityContextMock.mockResolvedValue(null);

    const result = await generateDraft(input("x"));

    expect(result.status).toBe("provider_unavailable");
    expect(result.platformNativeDraft).toBeDefined();
    expect(result.platformNativeDraft.creativeDirection).toBeDefined();
  });

  it("provider_generated path: envelope wraps the generated body", async () => {
    getPublishingIdentityContextMock.mockResolvedValue(fakeContext());
    readGenerationProviderStatusMock.mockReturnValue({ available: true });
    callGenerationProviderMock.mockResolvedValue({
      ok: true,
      text:
        "Refresh-token storage and incident rate are linked.\n\nWe moved to AES-GCM envelope encryption with per-workspace keys.\n\nIncident rate from rotated keys dropped to zero.",
    });

    const result = await generateDraft(input("x"));

    expect(result.status).toBe("provider_generated");
    expect(result.draft.bodyMarkdown).toContain("AES-GCM");
    expect(result.platformNativeDraft.body).toContain("AES-GCM");
    expect(result.platformNativeDraft.hook).toContain(
      "Refresh-token storage",
    );
  });

  it("provider_refused path: envelope present and carries the seeded body", async () => {
    getPublishingIdentityContextMock.mockResolvedValue(fakeContext());
    readGenerationProviderStatusMock.mockReturnValue({ available: true });
    callGenerationProviderMock.mockResolvedValue({
      ok: true,
      // Body contains a banned phrase ("10x") → safety verdict fails.
      text: "Our system delivers 10x performance on every query.",
    });

    const result = await generateDraft(input("x"));

    expect(result.status).toBe("provider_refused");
    expect(result.draft.safetyNotes.length).toBeGreaterThan(0);
    expect(result.platformNativeDraft).toBeDefined();
    expect(result.platformNativeDraft.creativeDirection).toBeDefined();
  });
});

describe("generateDraft — per-platform envelope differentiation", () => {
  const PLATFORMS: ReadonlyArray<FounderPlatform> = [
    "reddit",
    "x",
    "bluesky",
    "linkedin",
    "telegram",
    "devto",
    "instagram",
    "youtube",
  ];

  it("same canonical idea on different platforms returns different envelopes", async () => {
    readGenerationProviderStatusMock.mockReturnValue({ available: false });

    const envelopes = [];
    for (const p of PLATFORMS) {
      getPublishingIdentityContextMock.mockResolvedValue(
        fakeContext({ platform: p }),
      );
      const result = await generateDraft(input(p));
      envelopes.push(result.platformNativeDraft);
    }

    // Format variety — at least 4 distinct formats across 8 platforms.
    const formats = new Set(envelopes.map((e) => e.format));
    expect(formats.size).toBeGreaterThanOrEqual(4);

    // Creative direction briefs are unique per platform.
    const briefs = new Set(
      envelopes.map((e) => e.creativeDirection.mediaPromptOrBrief),
    );
    expect(briefs.size).toBe(envelopes.length);

    // mediaRequired exactly true for Instagram + YouTube.
    const igEnv = envelopes[PLATFORMS.indexOf("instagram")];
    const ytEnv = envelopes[PLATFORMS.indexOf("youtube")];
    expect(igEnv.creativeDirection.mediaRequired).toBe(true);
    expect(ytEnv.creativeDirection.mediaRequired).toBe(true);

    // No "discussion-CTA" leak: LinkedIn / X transformation notes
    // shouldn't mention 'discussion-first' (Reddit's home turf).
    const liEnv = envelopes[PLATFORMS.indexOf("linkedin")];
    const xEnv = envelopes[PLATFORMS.indexOf("x")];
    const liNotes = liEnv.transformationNotes.join(" ").toLowerCase();
    const xNotes = xEnv.transformationNotes.join(" ").toLowerCase();
    expect(liNotes).not.toContain("discussion-first");
    expect(xNotes).not.toContain("discussion-first");
  });
});

describe("generateDraft — backward compat", () => {
  it("legacy result.draft fields remain populated", async () => {
    getPublishingIdentityContextMock.mockResolvedValue(fakeContext());
    readGenerationProviderStatusMock.mockReturnValue({ available: false });

    const result = await generateDraft(input("x"));
    expect(result.draft).toBeDefined();
    expect(result.draft.bodyMarkdown.length).toBeGreaterThan(0);
    expect(result.draft.generatedByProvider).toBe(false);
    expect(typeof result.draft.title).toBe("string");
  });
});
