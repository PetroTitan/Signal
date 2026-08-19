import { describe, expect, it } from "vitest";
import { containsCausalClaim, MIN_N_FOR_MEDIAN } from "@/core/intelligence/statistics";
import {
  ARCHETYPES,
  CTA_TYPES,
  HOOK_TYPES,
  classifyArchetype,
  classifyCta,
  classifyHook,
} from "./classifiers";
import { buildContentMix, type ClassifiedForMix } from "./content-mix";
import { extractFeatures } from "./content-features";
import { classified, containsStrategyOverclaim } from "./evidence";
import {
  UNREALISTIC_AFTER_WEEKS,
  describeExperiments,
  suggestExperiments,
} from "./experiments";

const VOCAB = {
  archetypes: [...ARCHETYPES],
  hooks: [...HOOK_TYPES],
  ctas: [...CTA_TYPES],
  topics: [] as string[],
};

/** A real post from the production corpus: no question, no CTA, no link. */
const PLAIN =
  "Evidence needs a loop.\n\nAnalytics shows the situation. A decision changes something. Review shows whether the change worked.";

function item(body: string, index: number): ClassifiedForMix {
  const f = extractFeatures({
    id: `p${index}`,
    platform: "x",
    accountId: "a",
    handle: "h",
    publishedAt: "2026-06-01T12:00:00Z",
    title: null,
    body,
    linkUrl: null,
  });
  return {
    features: f,
    archetype: classifyArchetype(f, body),
    hook: classifyHook(f),
    cta: classifyCta(f, body),
    topic: classified("analytics", "weak", ["fixture"]),
  };
}

function mixOf(n: number) {
  return buildContentMix(
    Array.from({ length: n }, (_, i) => item(`${PLAIN} ${i}`, i)),
    VOCAB,
  );
}

const NOW = "2026-08-19T09:00:00Z";

describe("nothing to experiment with", () => {
  it("suggests nothing when nothing has been published", () => {
    const suggestions = suggestExperiments({
      mix: mixOf(0),
      postsPerWeek: 2,
      nowIso: NOW,
    });
    expect(suggestions).toHaveLength(0);
    expect(describeExperiments(suggestions, 2)).toContain("not enough published content");
  });
});

describe("an experiment is a question, not a prediction", () => {
  const suggestions = suggestExperiments({
    mix: mixOf(12),
    postsPerWeek: 1.4,
    nowIso: NOW,
  });

  it("produces suggestions from untested dimensions", () => {
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("phrases every one as a question", () => {
    for (const s of suggestions) {
      expect(s.question.endsWith("?"), s.question).toBe(true);
    }
  });

  it("predicts nothing and claims no cause anywhere", () => {
    for (const s of suggestions) {
      const text = [
        s.title,
        s.question,
        s.vary,
        s.readout,
        s.limitation,
        ...s.evidence.map((e) => e.statement),
      ].join(" ");
      expect(containsCausalClaim(text), text).toBe(false);
      expect(containsStrategyOverclaim(text), text).toBe(false);
    }
  });

  it("states the limitation on every suggestion, not just some", () => {
    for (const s of suggestions) {
      expect(s.limitation).toContain("does not");
      expect(s.limitation).toContain("caused");
    }
  });

  it("never blocks anything", () => {
    for (const s of suggestions) {
      expect(s.blocking).toBe(false);
    }
  });

  it("names what to hold constant so the arms stay comparable", () => {
    for (const s of suggestions) {
      expect(s.holdConstant.length).toBeGreaterThan(0);
      expect(s.holdConstant.join(" ")).toContain("platform");
    }
  });
});

describe("the honest arithmetic", () => {
  it("counts the posts still needed across both arms", () => {
    const [first] = suggestExperiments({ mix: mixOf(12), postsPerWeek: 1.4, nowIso: NOW });
    // One arm is empty and needs a full 6; the other already holds 12.
    expect(first.postsRemainingForDescriptive).toBe(MIN_N_FOR_MEDIAN);
    expect(first.weeksToDescriptive).toBe(Math.ceil(MIN_N_FOR_MEDIAN / 1.4));
  });

  it("says plainly when a question is not worth waiting on", () => {
    const [first] = suggestExperiments({ mix: mixOf(12), postsPerWeek: 0.1, nowIso: NOW });
    expect(first.status).toBe("not_realistic_at_this_rate");
    expect(first.readout).toContain("not a question worth waiting on");
    expect(first.weeksToDescriptive!).toBeGreaterThan(UNREALISTIC_AFTER_WEEKS);
  });

  it("keeps the readout descriptive when a verdict is out of reach", () => {
    // 2/week fills two arms of 6 quickly, but the verdict gate at 25 per
    // arm is a different order of magnitude.
    const [first] = suggestExperiments({ mix: mixOf(12), postsPerWeek: 2, nowIso: NOW });
    expect(first.weeksToVerdict!).toBeGreaterThan(first.weeksToDescriptive!);
    expect(first.readout.toLowerCase()).toContain("descriptive");
  });

  it("refuses to estimate a timeline it cannot know", () => {
    const [first] = suggestExperiments({ mix: mixOf(12), postsPerWeek: null, nowIso: NOW });
    expect(first.weeksToDescriptive).toBeNull();
    expect(first.readout).toContain("no honest estimate");
  });

  it("never invents a rate from a zero rate", () => {
    const [first] = suggestExperiments({ mix: mixOf(12), postsPerWeek: 0, nowIso: NOW });
    expect(first.weeksToDescriptive).toBeNull();
  });
});

describe("the dominant-dimension contrast", () => {
  it("offers a contrast once one archetype fills the feed", () => {
    const suggestions = suggestExperiments({ mix: mixOf(14), postsPerWeek: 2, nowIso: NOW });
    const contrast = suggestions.find((s) => s.id.startsWith("experiment-contrast-"));
    expect(contrast).toBeDefined();
    expect(contrast!.arms[0].postsSoFar).toBeGreaterThanOrEqual(MIN_N_FOR_MEDIAN);
    expect(contrast!.question).toContain("read differently");
  });
});

describe("the suggestion set stays a shortlist", () => {
  it("caps the list rather than enumerating every untested option", () => {
    const suggestions = suggestExperiments({ mix: mixOf(30), postsPerWeek: 3, nowIso: NOW });
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("summarises the set with the rate it actually used", () => {
    const suggestions = suggestExperiments({ mix: mixOf(12), postsPerWeek: 1.4, nowIso: NOW });
    expect(describeExperiments(suggestions, 1.4)).toContain("1.4 post(s) a week");
    expect(describeExperiments(suggestions, null)).toContain("not established");
  });
});
