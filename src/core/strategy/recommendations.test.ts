import { describe, expect, it } from "vitest";
import { extractFeatures } from "./content-features";
import { ARCHETYPES, CTA_TYPES, HOOK_TYPES, classifyArchetype, classifyCta, classifyHook } from "./classifiers";
import { buildContentMix, type ClassifiedForMix } from "./content-mix";
import { buildTopicModel } from "./topics";
import { analyzeDifferentiation } from "./differentiation";
import {
  MAX_OPTIONS,
  MIN_OPTIONS,
  coldStartOptions,
  recommendWhatToPostNext,
  type RecommendationInput,
} from "./recommendations";
import { classified, containsStrategyOverclaim } from "./evidence";
import { containsCausalClaim } from "@/core/intelligence/statistics";

const VOCAB = {
  archetypes: [...ARCHETYPES],
  hooks: [...HOOK_TYPES],
  ctas: [...CTA_TYPES],
  topics: [] as string[],
};

const PLAIN = "Evidence needs a loop.\n\nAnalytics shows the situation. Review shows whether it worked.";
const X_POST = "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility.";
const BSKY_POST = "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. Same demand this year.";

function item(body: string, platform = "x", day = 1): ClassifiedForMix {
  const f = extractFeatures({
    id: `${platform}-${day}`, platform, accountId: "a", handle: "h",
    publishedAt: `2026-06-${String(day).padStart(2, "0")}T12:00:00Z`,
    title: null, body, linkUrl: null,
  });
  return {
    features: f,
    archetype: classifyArchetype(f, body),
    hook: classifyHook(f),
    cta: classifyCta(f, body),
    topic: classified("t", "weak", ["x"]),
  };
}

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  const items = Array.from({ length: 6 }, (_, i) => item(PLAIN, "x", i + 1));
  return {
    mix: buildContentMix(items, VOCAB),
    topics: buildTopicModel([]),
    differentiation: analyzeDifferentiation([]),
    daysSinceLastPost: { x: 2 },
    platforms: ["x"],
    accountId: "a",
    nowIso: "2026-06-10T12:00:00Z",
    performance: null,
    ...over,
  };
}

describe("options, never an instruction", () => {
  it("returns between MIN and MAX options", () => {
    const options = recommendWhatToPostNext(input());
    expect(options.length).toBeGreaterThanOrEqual(MIN_OPTIONS);
    expect(options.length).toBeLessThanOrEqual(MAX_OPTIONS);
  });

  it("no option can block anything — structurally", () => {
    for (const o of recommendWhatToPostNext(input())) {
      expect(o.blocking).toBe(false);
      expect(o).not.toHaveProperty("required");
      expect(o).not.toHaveProperty("severity");
      expect(o).not.toHaveProperty("gate");
    }
  });

  it("phrases everything as a consideration, never a command", () => {
    for (const o of recommendWhatToPostNext(input())) {
      expect(o.title.toLowerCase()).not.toMatch(/^you must|^do not publish|^stop /);
      expect(o.rationale.toLowerCase()).not.toMatch(/you must|required|not allowed|forbidden/);
    }
  });

  it("every option carries evidence", () => {
    for (const o of recommendWhatToPostNext(input())) {
      expect(o.evidence.length, o.id).toBeGreaterThan(0);
      for (const e of o.evidence) expect(e.statement.length).toBeGreaterThan(10);
    }
  });

  it("is deterministic", () => {
    const a = recommendWhatToPostNext(input());
    const b = recommendWhatToPostNext(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("COLD START — useful with nothing published", () => {
  const cold = recommendWhatToPostNext(
    input({ mix: buildContentMix([], VOCAB), platforms: ["bluesky"], daysSinceLastPost: {} }),
  );

  it("still returns real options", () => {
    expect(cold.length).toBeGreaterThanOrEqual(MIN_OPTIONS);
    expect(cold.every((o) => o.kind === "cold_start")).toBe(true);
  });

  it("says plainly that there is no evidence yet", () => {
    for (const o of cold) {
      expect(o.confidence).toBe("none");
      expect(o.evidence.some((e) => e.statement.includes("Nothing has been published"))).toBe(true);
    }
  });

  it("suggests DIFFERENT shapes, so the first posts are comparable later", () => {
    const archetypes = new Set(cold.map((o) => o.suggestedArchetype));
    expect(archetypes.size).toBeGreaterThanOrEqual(3);
  });

  it("makes no performance claim at all", () => {
    for (const o of cold) {
      const text = `${o.title} ${o.rationale} ${o.evidence.map((e) => e.statement).join(" ")}`;
      expect(containsStrategyOverclaim(text), text).toBe(false);
      expect(containsCausalClaim(text), text).toBe(false);
    }
  });

  it("coldStartOptions is directly callable and never empty", () => {
    expect(coldStartOptions(input()).length).toBeGreaterThanOrEqual(MIN_OPTIONS);
  });
});

describe("EXPLORATION is guaranteed", () => {
  it("always includes an explore option when something is untested", () => {
    const options = recommendWhatToPostNext(input());
    expect(options.some((o) => o.kind === "explore")).toBe(true);
  });

  it("includes exploration even when performance evidence exists", () => {
    // The self-reinforcing-loop guard: a winner must not crowd out
    // everything the operator has never tried.
    const options = recommendWhatToPostNext(
      input({
        performance: {
          strongest: [{ dimension: "archetype", value: "educational", label: "Educational", n: 30, median: 12 }],
          verdictPermitted: true,
          sampleSize: 30,
        },
      }),
    );
    expect(options.some((o) => o.kind === "exploit")).toBe(true);
    expect(options.some((o) => o.kind === "explore")).toBe(true);
  });

  it("never returns exploit-only", () => {
    const options = recommendWhatToPostNext(
      input({
        performance: {
          strongest: [{ dimension: "hook", value: "question", label: "Question", n: 40, median: 20 }],
          verdictPermitted: true,
          sampleSize: 40,
        },
      }),
    );
    expect(options.every((o) => o.kind === "exploit")).toBe(false);
  });
});

describe("evidence strength matches the data", () => {
  it("an exploit option is only weak when the sample is small", () => {
    const small = recommendWhatToPostNext(
      input({
        performance: {
          strongest: [{ dimension: "archetype", value: "educational", label: "Educational", n: 4, median: 3 }],
          verdictPermitted: false,
          sampleSize: 4,
        },
      }),
    ).find((o) => o.kind === "exploit")!;
    expect(small.confidence).toBe("weak");
    expect(small.rationale).toContain("small sample");
  });

  it("says there is no performance data when there is none", () => {
    const options = recommendWhatToPostNext(input());
    const text = options.flatMap((o) => o.evidence.map((e) => e.statement)).join(" ");
    expect(text).toContain("No performance data has been collected yet");
  });
});

describe("cross-platform differentiation surfaces as an option", () => {
  it("offers a platform-native rewrite when a near-copy exists", () => {
    const diff = analyzeDifferentiation([
      { id: "x1", platform: "x", publishedAt: "2026-08-15T14:05:00Z", title: null, body: X_POST, linkUrl: null },
      { id: "b1", platform: "bluesky", publishedAt: "2026-08-15T14:25:00Z", title: null, body: BSKY_POST, linkUrl: null },
    ]);
    const options = recommendWhatToPostNext(input({ differentiation: diff, platforms: ["x", "bluesky"] }));
    const d = options.find((o) => o.kind === "differentiate");
    expect(d).toBeTruthy();
    expect(d!.rationale.toLowerCase()).toContain("conversational");
    expect(d!.blocking).toBe(false);
  });

  it("offers nothing to differentiate when the posts differ", () => {
    const diff = analyzeDifferentiation([
      { id: "x1", platform: "x", publishedAt: "2026-08-15T14:05:00Z", title: null, body: "Roaming charges surprise people who cross a border.", linkUrl: null },
      { id: "b1", platform: "bluesky", publishedAt: "2026-08-15T14:25:00Z", title: null, body: "Instrumentation starts before the event name is chosen.", linkUrl: null },
    ]);
    expect(recommendWhatToPostNext(input({ differentiation: diff })).some((o) => o.kind === "differentiate")).toBe(false);
  });
});

describe("inactivity", () => {
  it("suggests resuming after a long gap", () => {
    const options = recommendWhatToPostNext(input({ daysSinceLastPost: { x: 63 } }));
    const resume = options.find((o) => o.kind === "resume");
    expect(resume).toBeTruthy();
    expect(resume!.rationale).toContain("63 days");
  });

  it("does not nag about a recent post", () => {
    expect(recommendWhatToPostNext(input({ daysSinceLastPost: { x: 1 } })).some((o) => o.kind === "resume")).toBe(false);
  });
});

describe("no option makes a causal or predictive claim", () => {
  it("scans every emitted string across every input shape", () => {
    const shapes = [
      input(),
      input({ mix: buildContentMix([], VOCAB) }),
      input({ daysSinceLastPost: { x: 63 } }),
      input({
        performance: {
          strongest: [{ dimension: "archetype", value: "educational", label: "Educational", n: 30, median: 12 }],
          verdictPermitted: true,
          sampleSize: 30,
        },
      }),
    ];
    for (const shape of shapes) {
      for (const o of recommendWhatToPostNext(shape)) {
        const text = `${o.title} ${o.rationale} ${o.experimentIntent ?? ""} ${o.evidence.map((e) => e.statement).join(" ")}`;
        expect(containsStrategyOverclaim(text), text).toBe(false);
        expect(containsCausalClaim(text), text).toBe(false);
      }
    }
  });
});
