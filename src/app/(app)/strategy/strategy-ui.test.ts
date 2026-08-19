import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { containsCausalClaim } from "@/core/intelligence/statistics";
import { containsStrategyOverclaim } from "@/core/strategy/evidence";
import {
  ARCHETYPES,
  CTA_TYPES,
  HOOK_TYPES,
  classifyArchetype,
  classifyCta,
  classifyHook,
} from "@/core/strategy/classifiers";
import { extractFeatures } from "@/core/strategy/content-features";
import { buildContentMix, type ClassifiedForMix } from "@/core/strategy/content-mix";
import { buildTopicModel } from "@/core/strategy/topics";
import { analyzeDifferentiation } from "@/core/strategy/differentiation";
import { suggestExperiments } from "@/core/strategy/experiments";
import { recommendWhatToPostNext } from "@/core/strategy/recommendations";
import { classified } from "@/core/strategy/evidence";
import {
  CONFIDENCE_LABEL,
  EvidenceList,
  ExperimentCard,
  InterpretationBlock,
  KIND_LABEL,
  MixRow,
  OptionCard,
  PairRow,
  PerformanceRow,
} from "./_strategy-cards";

const PLAIN =
  "Evidence needs a loop.\n\nAnalytics shows the situation. A decision changes something. Review shows whether the change worked.";

function item(body: string, index: number): ClassifiedForMix {
  const f = extractFeatures({
    id: `p${index}`,
    platform: index % 2 === 0 ? "x" : "bluesky",
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

const mix = buildContentMix(
  Array.from({ length: 12 }, (_, i) => item(`${PLAIN} ${i}`, i)),
  {
    archetypes: [...ARCHETYPES],
    hooks: [...HOOK_TYPES],
    ctas: [...CTA_TYPES],
    topics: [],
  },
);

const differentiation = analyzeDifferentiation([
  {
    id: "a",
    platform: "x",
    publishedAt: "2026-08-15T09:00:00Z",
    title: null,
    body: PLAIN,
    linkUrl: null,
  },
  {
    id: "b",
    platform: "bluesky",
    publishedAt: "2026-08-15T09:04:00Z",
    title: null,
    body: `${PLAIN} One more thought on that.`,
    linkUrl: null,
  },
]);

const options = recommendWhatToPostNext({
  mix,
  topics: buildTopicModel([]),
  differentiation,
  daysSinceLastPost: { x: 3, bluesky: 9 },
  platforms: ["x", "bluesky"],
  accountId: "a",
  nowIso: "2026-08-19T09:00:00Z",
  performance: null,
});

const experiments = suggestExperiments({
  mix,
  postsPerWeek: 1.4,
  nowIso: "2026-08-19T09:00:00Z",
});

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe("options render as options", () => {
  const markup = options.map((o) => render(createElement(OptionCard, { option: o }))).join("\n");

  it("renders every option", () => {
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(markup).toContain(option.title);
    }
  });

  it("shows the evidence for each, not behind a disclosure", () => {
    for (const option of options) {
      for (const evidence of option.evidence) {
        expect(markup).toContain(evidence.statement.slice(0, 40));
      }
    }
    expect(markup).not.toContain("<details");
  });

  it("labels every statement as fact, observation or suggestion", () => {
    for (const option of options) {
      for (const evidence of option.evidence) {
        expect(["Fact", "Observation", "Suggestion", "Experiment", "AI interpretation"]).toContain(
          evidence.category === "ai_interpretation"
            ? "AI interpretation"
            : evidence.category.charAt(0).toUpperCase() + evidence.category.slice(1),
        );
      }
    }
    expect(markup).toMatch(/Fact|Observation/);
  });

  it("states the confidence rather than implying it", () => {
    const labels = Object.values(CONFIDENCE_LABEL);
    expect(labels.some((label) => markup.includes(label))).toBe(true);
  });

  it("renders no disabled control and no form", () => {
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<button");
  });

  it("uses no severity colouring for an untested option", () => {
    // badge-high and badge-medium are the warning scales. An option the
    // operator has simply never tried is not a warning.
    expect(markup).not.toContain("badge-high");
    expect(markup).not.toContain("badge-medium");
  });

  it("carries no causal claim and no overclaim", () => {
    const text = stripTags(markup);
    expect(containsCausalClaim(text)).toBe(false);
    expect(containsStrategyOverclaim(text)).toBe(false);
  });

  it("names each option's kind in plain words", () => {
    for (const option of options) {
      expect(markup).toContain(KIND_LABEL[option.kind]);
    }
  });
});

describe("the content mix admits its own sample size", () => {
  const markup = render(createElement(MixRow, { dimension: mix.archetypes }));

  it("says counts are counts when percentages would be false precision", () => {
    expect(mix.archetypes.usesPercentages).toBe(true);
    const small = buildContentMix([item(PLAIN, 0), item(PLAIN, 1)], {
      archetypes: [...ARCHETYPES],
      hooks: [...HOOK_TYPES],
      ctas: [...CTA_TYPES],
      topics: [],
    });
    const smallMarkup = render(createElement(MixRow, { dimension: small.archetypes }));
    expect(smallMarkup).toContain("counts only");
    expect(smallMarkup).not.toMatch(/\d+%/);
  });

  it("shows a percentage only once the denominator carries it", () => {
    expect(markup).toMatch(/\d+%/);
  });
});

describe("performance rows never imply more than the sample allows", () => {
  it("prints the sample size beside every statement", () => {
    const markup = render(
      createElement(PerformanceRow, {
        entry: {
          dimension: "archetype",
          value: "educational",
          label: "Educational",
          n: 4,
          median: null,
          p25: null,
          p75: null,
          verdict: "insufficient_data" as const,
          level: "none" as const,
          statement:
            "Only 4 measured post(s) with educational — below the 6 needed to report a median.",
        },
      }),
    );
    expect(markup).toContain("n = 4");
    expect(markup).toContain("below the 6 needed");
  });
});

describe("cross-platform pairs read as measurement, not judgement", () => {
  const pair = differentiation.similarPairs[0];

  it("found the real pair shape: same opening, different length", () => {
    expect(pair).toBeDefined();
    const markup = render(createElement(PairRow, { pair }));
    expect(markup).toContain("opening line");
    expect(markup).toContain("Suggestion");
    expect(markup).not.toContain("badge-high");
  });
});

describe("experiments render their arithmetic and their limits", () => {
  const markup = experiments
    .map((e) => render(createElement(ExperimentCard, { experiment: e })))
    .join("\n");

  it("shows the question, the readout and what it will not establish", () => {
    expect(experiments.length).toBeGreaterThan(0);
    for (const experiment of experiments) {
      expect(markup).toContain(experiment.question);
      expect(markup).toContain(experiment.limitation.slice(0, 40));
    }
  });
});

describe("the AI section is unmistakable and optional", () => {
  it("labels the interpretation as AI even when there is text", () => {
    const markup = render(
      createElement(InterpretationBlock, {
        text: "Nothing has been measured yet, so the options rest on what you published.",
        note: null,
      }),
    );
    expect(markup).toContain("AI interpretation");
    expect(markup).toContain("cannot introduce a number");
  });

  it("explains its own absence without calling it an error", () => {
    const markup = render(
      createElement(InterpretationBlock, {
        text: null,
        note: "AI interpretation is off. Everything above is computed without it.",
      }),
    );
    expect(markup).toContain("Everything above is computed without it");
    expect(markup.toLowerCase()).not.toContain("error");
  });
});

describe("evidence lists always carry their source", () => {
  it("prints where each statement came from", () => {
    const markup = render(
      createElement(EvidenceList, {
        evidence: [
          { category: "fact" as const, statement: "12 posts published.", source: "publish_history" },
        ],
      }),
    );
    expect(markup).toContain("publish_history");
    expect(markup).toContain("Fact");
  });
});

describe("the page itself stays advisory", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/app/(app)/strategy/page.tsx"),
    "utf8",
  );

  it("contains no form, no action and no mutation", () => {
    expect(source).not.toContain("<form");
    expect(source).not.toContain("use server");
    expect(source).not.toContain("Action(");
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("tells the operator plainly that nothing here blocks anything", () => {
    expect(source).toContain("never block publishing, approval or scheduling");
  });

  it("renders the AI section after the deterministic evidence", () => {
    // The page must read in the same order the pipeline runs.
    // The rendered element, not the import at the top of the file.
    expect(source.indexOf("<InterpretationBlock")).toBeGreaterThan(
      source.indexOf("What to post next"),
    );
  });
});

function stripTags(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
