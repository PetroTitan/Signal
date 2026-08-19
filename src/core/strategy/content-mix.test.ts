import { describe, expect, it } from "vitest";
import { extractFeatures } from "./content-features";
import { ARCHETYPES, CTA_TYPES, HOOK_TYPES, classifyArchetype, classifyCta, classifyHook } from "./classifiers";
import {
  MIN_N_FOR_PERCENTAGES,
  buildContentMix,
  dominantDimensions,
  untestedDimensions,
  type ClassifiedForMix,
} from "./content-mix";
import { classified } from "./evidence";

const VOCAB = {
  archetypes: [...ARCHETYPES],
  hooks: [...HOOK_TYPES],
  ctas: [...CTA_TYPES],
  topics: [] as string[],
};

function item(body: string, over: { platform?: string; hasCreative?: boolean; linkUrl?: string | null } = {}): ClassifiedForMix {
  const f = extractFeatures({
    id: Math.random().toString(36).slice(2),
    platform: over.platform ?? "x",
    accountId: "a", handle: "h",
    publishedAt: "2026-06-01T12:00:00Z",
    title: null, body, linkUrl: over.linkUrl ?? null,
    hasCreative: over.hasCreative,
  });
  return {
    features: f,
    archetype: classifyArchetype(f, body),
    hook: classifyHook(f),
    cta: classifyCta(f, body),
    topic: classified("t", "weak", ["x"]),
  };
}

const PLAIN = "Evidence needs a loop.\n\nAnalytics shows the situation. Review shows whether it worked.";

describe("counts, not percentages, at small n", () => {
  it("reports counts below the threshold", () => {
    const mix = buildContentMix([item(PLAIN), item(PLAIN), item(PLAIN)], VOCAB);
    expect(mix.archetypes.usesPercentages).toBe(false);
    expect(mix.archetypes.entries[0].percent).toBeNull();
    expect(mix.archetypes.summary).toMatch(/\d+ industry commentary of 3 posts/);
  });

  it("switches to percentages once the denominator can carry them", () => {
    const many = Array.from({ length: MIN_N_FOR_PERCENTAGES }, () => item(PLAIN));
    const mix = buildContentMix(many, VOCAB);
    expect(mix.archetypes.usesPercentages).toBe(true);
    expect(mix.archetypes.entries[0].percent).toBe(100);
  });

  it("never reports a percentage from a handful of posts", () => {
    for (let n = 1; n < MIN_N_FOR_PERCENTAGES; n += 1) {
      const mix = buildContentMix(Array.from({ length: n }, () => item(PLAIN)), VOCAB);
      for (const e of mix.archetypes.entries) expect(e.percent, `n=${n}`).toBeNull();
    }
  });
});

describe("no target ratios exist", () => {
  it("exposes no ideal mix anywhere in the output", () => {
    const mix = buildContentMix([item(PLAIN)], VOCAB);
    const json = JSON.stringify(mix).toLowerCase();
    expect(json).not.toContain("ideal");
    expect(json).not.toContain("target");
    expect(json).not.toContain("recommended ratio");
    expect(json).not.toContain("should be");
  });

  it("describes concentration without judging it", () => {
    const mix = buildContentMix(Array.from({ length: 10 }, () => item(PLAIN)), VOCAB);
    const dominant = dominantDimensions(mix);
    expect(dominant.length).toBeGreaterThan(0);
    for (const d of dominant) {
      expect(d.toLowerCase()).not.toMatch(/too much|excessive|should|must|problem/);
    }
  });
});

describe("unknown is counted, never folded into a negative", () => {
  it("keeps creative-unknown apart from creative-absent", () => {
    const mix = buildContentMix(
      [item(PLAIN), item(PLAIN, { hasCreative: false }), item(PLAIN, { hasCreative: true })],
      VOCAB,
    );
    expect(mix.binary.creativeUnknown).toBe(1);
    expect(mix.binary.withoutCreative).toBe(1);
    expect(mix.binary.withCreative).toBe(1);
  });

  it("tracks how many classifications were weak", () => {
    const mix = buildContentMix([item(PLAIN), item(PLAIN)], VOCAB);
    expect(mix.archetypes.entries[0].weakClassifications).toBeGreaterThan(0);
  });
});

describe("untested dimensions are FACTS, needing no performance data", () => {
  it("reports the real corpus gaps as countable facts", () => {
    const mix = buildContentMix(Array.from({ length: 5 }, () => item(PLAIN)), VOCAB);
    const untested = untestedDimensions(mix);
    const facts = untested.map((u) => u.fact);
    expect(facts.some((f) => f.includes("opens with a question"))).toBe(true);
    expect(facts.some((f) => f.includes("carries a link"))).toBe(true);
    expect(facts.some((f) => f.includes("call to action"))).toBe(true);
    // Every fact is a count, not a prediction.
    for (const f of facts) {
      expect(f).toMatch(/None of your|You have not/);
      expect(f.toLowerCase()).not.toMatch(/will|would|better|worse|increase/);
    }
  });

  it("does NOT claim a dimension is untested when it has been used", () => {
    const withQuestion = "Most dashboards answer the wrong question.\n\nWhat would yours need to show?";
    const mix = buildContentMix([item(withQuestion), item(withQuestion)], VOCAB);
    const facts = untestedDimensions(mix).map((u) => u.fact);
    expect(facts.some((f) => f.includes("ends with a question"))).toBe(false);
  });

  it("returns nothing for an empty corpus rather than claiming everything is untested", () => {
    expect(untestedDimensions(buildContentMix([], VOCAB))).toEqual([]);
  });
});

describe("cold start", () => {
  it("summarises an empty mix honestly", () => {
    const mix = buildContentMix([], VOCAB);
    expect(mix.total).toBe(0);
    expect(mix.summary).toBe("Nothing published yet.");
    expect(dominantDimensions(mix)).toEqual([]);
  });
});
