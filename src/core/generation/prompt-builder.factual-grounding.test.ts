import { describe, expect, it } from "vitest";
import { buildGenerationPrompt } from "./prompt-builder";
import type { GenerationPromptContext } from "./generation-types";

function baseContext(
  over: Partial<GenerationPromptContext> = {},
): GenerationPromptContext {
  return {
    identityDisplayName: "Petro",
    identityHandle: "@petro",
    platform: "bluesky",
    platformLabel: "Bluesky",
    voiceProfile: "Calm technical founder.",
    sourceWebsiteUrl: null,
    referenceUrls: [],
    product: null,
    platformVoiceHint: null,
    recentTopics: [],
    input: {
      weeklyPlanId: null,
      identityId: "id-1",
      platform: null,
      productId: null,
      topic: "Why operators benefit from explicit publishing intent",
      goal: null,
      cta: null,
      sourceUrl: null,
      toneAdjustment: null,
      schedulePreference: null,
    },
    ...over,
  };
}

describe("buildGenerationPrompt — factual grounding (Phase F7.0)", () => {
  it("emits the primary source URL when supplied", () => {
    const { system } = buildGenerationPrompt(
      baseContext({ sourceWebsiteUrl: "https://www.webmasterid.com" }),
    );
    expect(system).toMatch(/Primary source: https:\/\/www\.webmasterid\.com/);
    expect(system).toMatch(/publishes on behalf of THIS site/);
  });

  it("emits a 'not set' note when source is null (legacy row)", () => {
    const { system } = buildGenerationPrompt(baseContext());
    expect(system).toMatch(/Primary source: \(not set\)/);
  });

  it("lists reference URLs when supplied", () => {
    const { system } = buildGenerationPrompt(
      baseContext({
        sourceWebsiteUrl: "https://www.webmasterid.com",
        referenceUrls: [
          "https://models.webmasterid.com",
          "https://radar.webmasterid.com",
        ],
      }),
    );
    expect(system).toMatch(/Additional references:/);
    expect(system).toMatch(/models\.webmasterid\.com/);
    expect(system).toMatch(/radar\.webmasterid\.com/);
  });

  it("always emits the 'DO NOT draft about internal infrastructure' rule", () => {
    const { system: withSource } = buildGenerationPrompt(
      baseContext({ sourceWebsiteUrl: "https://www.webmasterid.com" }),
    );
    expect(withSource).toMatch(
      /DO NOT draft about Signal's internal infrastructure/i,
    );
    expect(withSource).toMatch(/MCP implementation/i);
    expect(withSource).toMatch(/scheduler runtime/i);
    expect(withSource).toMatch(/approval-hash/i);

    const { system: legacy } = buildGenerationPrompt(baseContext());
    // Rule fires for legacy rows too — the boundary is platform-agnostic.
    expect(legacy).toMatch(
      /DO NOT draft about Signal's internal infrastructure/i,
    );
  });
});
