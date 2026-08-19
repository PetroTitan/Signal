import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHENTICATED_ROUTES } from "@/core/navigation/route-manifest";
import { containsCausalClaim, MIN_N_FOR_VERDICT } from "@/core/intelligence/statistics";
import { metricAvailability, supportsImpressions } from "@/core/metrics/metric-availability";
import {
  ARCHETYPES,
  CTA_TYPES,
  HOOK_TYPES,
  classifyArchetype,
  classifyCta,
  classifyHook,
} from "./classifiers";
import { extractFeatures } from "./content-features";
import { buildContentMix, type ClassifiedForMix } from "./content-mix";
import { analyzeDifferentiation } from "./differentiation";
import { classified } from "./evidence";
import { suggestExperiments } from "./experiments";
import { analyzePerformance, toRecommendationPerformance, type MeasuredPost } from "./performance";
import { MIN_OPTIONS, recommendWhatToPostNext } from "./recommendations";
import { buildTopicModel } from "./topics";

/**
 * THE INVARIANTS OF AN ADVISORY LAYER.
 *
 * Each block below is a negative control: the comment names the change
 * that must make it fail, and each was actually applied and reverted
 * during development rather than asserted from the armchair. A guard
 * that has never been seen to fail is a guard nobody has tested.
 */

const SRC = path.join(process.cwd(), "src");
const STRATEGY_DIR = path.join(SRC, "core/strategy");

function strategySources(): Array<{ file: string; source: string }> {
  return readdirSync(STRATEGY_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, source: readFileSync(path.join(STRATEGY_DIR, f), "utf8") }));
}

/** Source with comments removed — a documented counterexample is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const PLAIN =
  "Evidence needs a loop.\n\nAnalytics shows the situation. A decision changes something. Review shows whether the change worked.";

function item(body: string, index: number, platform = "x"): ClassifiedForMix {
  const f = extractFeatures({
    id: `p${index}`,
    platform,
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

const VOCAB = {
  archetypes: [...ARCHETYPES],
  hooks: [...HOOK_TYPES],
  ctas: [...CTA_TYPES],
  topics: [] as string[],
};

function mixOf(n: number) {
  return buildContentMix(
    Array.from({ length: n }, (_, i) => item(`${PLAIN} ${i}`, i)),
    VOCAB,
  );
}

const NOW = "2026-08-19T09:00:00Z";

// ---------------------------------------------------------------------
// NC1 — make a strategy recommendation block publishing
// ---------------------------------------------------------------------
describe("NC1: no recommendation can block publishing", () => {
  const options = recommendWhatToPostNext({
    mix: mixOf(12),
    topics: buildTopicModel([]),
    differentiation: analyzeDifferentiation([]),
    daysSinceLastPost: { x: 2 },
    platforms: ["x"],
    accountId: "a",
    nowIso: NOW,
    performance: null,
  });

  it("marks every option non-blocking at runtime", () => {
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.blocking, option.id).toBe(false);
    }
  });

  it("keeps the blocking flag a literal `false` in the type, not a boolean", () => {
    // `blocking: boolean` would let a future option set it true and
    // still compile. The literal type is the actual guard.
    const source = readFileSync(path.join(STRATEGY_DIR, "recommendations.ts"), "utf8");
    expect(source).toContain("blocking: false;");
  });

  it("is not imported by any publishing, approval or scheduling path", () => {
    // The strongest form of "advice cannot block": the code that
    // decides whether a post may go out cannot see this layer at all.
    const decisionDirs = [
      "core/publishing",
      "core/scheduler",
      "core/approval",
      "core/weekly-contract",
    ].filter((d) => {
      try {
        readdirSync(path.join(SRC, d));
        return true;
      } catch {
        return false;
      }
    });
    expect(decisionDirs.length).toBeGreaterThan(0);
    for (const dir of decisionDirs) {
      for (const file of walk(path.join(SRC, dir))) {
        const source = readFileSync(file, "utf8");
        expect(source, `${file} imports the strategy layer`).not.toMatch(
          /from "@\/core\/strategy/,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------
// NC2 — make 100% cross-platform similarity disable scheduling
// ---------------------------------------------------------------------
describe("NC2: identical cross-platform copy stays publishable", () => {
  const identical = analyzeDifferentiation([
    { id: "a", platform: "x", publishedAt: "2026-08-15T09:00:00Z", title: null, body: PLAIN, linkUrl: null },
    { id: "b", platform: "bluesky", publishedAt: "2026-08-15T09:01:00Z", title: null, body: PLAIN, linkUrl: null },
  ]);

  it("detects the duplicate", () => {
    expect(identical.similarPairs[0]?.exactDuplicate).toBe(true);
    expect(identical.similarPairs[0]?.messagePercent).toBe(100);
  });

  it("exposes no field a caller could read as a block", () => {
    const pair = identical.similarPairs[0] as unknown as Record<string, unknown>;
    for (const key of Object.keys(pair)) {
      expect(key, `PairDifferentiation.${key} reads as a gate`).not.toMatch(
        /^(blocked|blocking|allowed|permitted|disabled|prevent)/i,
      );
    }
  });

  it("uses no gating vocabulary in the module itself", () => {
    const source = stripComments(
      readFileSync(path.join(STRATEGY_DIR, "differentiation.ts"), "utf8"),
    );
    for (const forbidden of ["disableScheduling", "blockPublish", "canPublish", "isAllowed"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------
// NC3 — make a small sample generate a causal performance claim
// ---------------------------------------------------------------------
describe("NC3: a small sample never produces a causal claim", () => {
  function measured(n: number, body: string, engagement: number): MeasuredPost[] {
    return Array.from({ length: n }, (_, i) => {
      const f = extractFeatures({
        id: `m${body}${i}`,
        platform: "x",
        accountId: "a",
        handle: "h",
        publishedAt: "2026-06-01T12:00:00Z",
        title: null,
        body: `${body} ${i}`,
        linkUrl: null,
      });
      return {
        features: f,
        archetype: classifyArchetype(f, body),
        hook: classifyHook(f),
        cta: classifyCta(f, body),
        topic: classified("analytics", "weak", ["fixture"]),
        engagement,
        ageWindow: "24h",
      };
    });
  }

  // Five measured posts in total — below MIN_N_FOR_MEDIAN, so no
  // dimension can report anything, however lopsided the values are.
  const small = analyzePerformance([
    ...measured(3, "What changed this week?", 40),
    ...measured(2, "Plain statement", 1),
  ]);

  it("withholds a median and a verdict", () => {
    expect(small.level).toBe("none");
    expect(small.overall.verdict).toBe("insufficient_data");
    expect(small.strongest).toHaveLength(0);
  });

  it("emits no causal sentence at any evidence level", () => {
    const large = analyzePerformance(measured(MIN_N_FOR_VERDICT + 1, "Plain statement", 3));
    for (const evidence of [small, large]) {
      const texts = [
        evidence.summary,
        ...evidence.observations.map((o) => o.statement),
        ...evidence.byArchetype.map((d) => d.statement),
      ];
      for (const text of texts) expect(containsCausalClaim(text), text).toBe(false);
    }
  });

  it("does not hand an unqualified winner to the recommendation engine", () => {
    expect(toRecommendationPerformance(small)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// NC4 — treat unavailable Bluesky impressions as zero
// ---------------------------------------------------------------------
describe("NC4: an unavailable metric is never a zero", () => {
  it("still knows Bluesky reports no impressions of any kind", () => {
    expect(supportsImpressions("bluesky")).toBe(false);
    expect(metricAvailability("bluesky", "impressions")).not.toBe("available");
  });

  it("excludes unmeasured posts from the sample rather than scoring them zero", () => {
    const f = extractFeatures({
      id: "u",
      platform: "bluesky",
      accountId: "a",
      handle: "h",
      publishedAt: "2026-06-01T12:00:00Z",
      title: null,
      body: PLAIN,
      linkUrl: null,
    });
    const base = {
      features: f,
      archetype: classifyArchetype(f, PLAIN),
      hook: classifyHook(f),
      cta: classifyCta(f, PLAIN),
      topic: classified("analytics", "weak", ["fixture"]),
      ageWindow: "24h",
    };
    const unmeasured = analyzePerformance([
      { ...base, engagement: null },
      { ...base, engagement: null },
    ]);
    expect(unmeasured.measuredCount).toBe(0);
    expect(unmeasured.overall.n).toBe(0);
    expect(unmeasured.overall.median).toBeNull();
    expect(unmeasured.summary).toContain("No post has been measured");
  });

  it("keeps the exclusion in the loader, not only in the analyser", () => {
    const loader = readFileSync(path.join(STRATEGY_DIR, "load-strategy.server.ts"), "utf8");
    // A row whose status is not `connected` must not become a zero.
    expect(loader).toContain('if (m.status !== "connected") continue;');
    expect(loader).toContain("engagement: measured?.engagement ?? null");
  });
});

// ---------------------------------------------------------------------
// NC5 — remove workspace scoping from a strategy query
// ---------------------------------------------------------------------
describe("NC5: every strategy query is workspace-scoped", () => {
  const loader = readFileSync(path.join(STRATEGY_DIR, "load-strategy.server.ts"), "utf8");
  const tables = Array.from(loader.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g));

  it("reads more than one table, so the check is not trivially satisfied", () => {
    expect(tables.length).toBeGreaterThan(1);
  });

  it("scopes each read to the workspace", () => {
    for (const match of tables) {
      const statement = loader.slice(match.index ?? 0, (match.index ?? 0) + 1200).split(/;\s*\n/)[0];
      expect(statement, `.from("${match[1]}") is unscoped`).toMatch(
        /\.eq\(\s*"workspace_id"\s*,\s*workspaceId\s*\)/,
      );
    }
  });
});

// ---------------------------------------------------------------------
// NC6 — make AI required for recommendations
// ---------------------------------------------------------------------
describe("NC6: recommendations never depend on a model", () => {
  it("produces options with no provider and no performance data", () => {
    const options = recommendWhatToPostNext({
      mix: mixOf(8),
      topics: buildTopicModel([]),
      differentiation: analyzeDifferentiation([]),
      daysSinceLastPost: {},
      platforms: ["x"],
      accountId: null,
      nowIso: NOW,
      performance: null,
    });
    expect(options.length).toBeGreaterThanOrEqual(MIN_OPTIONS);
  });

  it("keeps the deterministic layer free of any AI import", () => {
    for (const { file, source } of strategySources()) {
      if (file.startsWith("ai-interpretation") || file.startsWith("interpret-strategy")) continue;
      expect(source, `${file} imports the AI layer`).not.toMatch(
        /from "\.\/(ai-interpretation|interpret-strategy)/,
      );
      expect(source, `${file} imports a generation provider`).not.toMatch(
        /from "@\/core\/generation/,
      );
    }
  });

  it("never lets the model reach the evidence pipeline in reverse", () => {
    // The AI reads the evidence. The evidence must never read the AI.
    const loader = readFileSync(path.join(STRATEGY_DIR, "load-strategy.server.ts"), "utf8");
    expect(loader).not.toContain("interpretStrategy");
  });
});

// ---------------------------------------------------------------------
// NC7 — remove the mobile route to Strategy
// ---------------------------------------------------------------------
describe("NC7: /strategy is reachable on mobile", () => {
  const entry = AUTHENTICATED_ROUTES.find((r) => r.href === "/strategy");

  it("is classified in the route manifest", () => {
    expect(entry).toBeDefined();
  });

  it("sits in a tier that appears in a mobile surface", () => {
    // primary → bottom bar; secondary/settings → the More sheet.
    expect(["primary", "secondary", "settings"]).toContain(entry!.tier);
  });

  it("appears in the desktop sidebar too, so the surfaces agree", () => {
    const sidebar = readFileSync(path.join(SRC, "components/sidebar.tsx"), "utf8");
    expect(sidebar).toContain('href: "/strategy"');
  });
});

// ---------------------------------------------------------------------
// NC8 — an account with no history renders a useless page
// ---------------------------------------------------------------------
describe("NC8: cold start is useful, not empty", () => {
  const options = recommendWhatToPostNext({
    mix: buildContentMix([], VOCAB),
    topics: buildTopicModel([]),
    differentiation: analyzeDifferentiation([]),
    daysSinceLastPost: {},
    platforms: [],
    accountId: null,
    nowIso: NOW,
    performance: null,
  });

  it("returns real options with no history at all", () => {
    expect(options.length).toBeGreaterThanOrEqual(MIN_OPTIONS);
  });

  it("offers distinct starting points rather than one idea repeated", () => {
    expect(new Set(options.map((o) => o.title)).size).toBe(options.length);
  });

  it("admits it has no evidence instead of implying it has some", () => {
    for (const option of options) {
      expect(option.confidence).toBe("none");
      expect(option.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------
// NC9 — recommend only historical winners, never exploration
// ---------------------------------------------------------------------
/**
 * Running this control was informative: breaking one exploration source
 * did not fail the test, because there are FOUR independent ones — the
 * untested-dimension branch, the dominant-dimension variation, the
 * balance() backstop, and the filler ideas. The guard only fires when an
 * engine is genuinely exploit-only, which is the right sensitivity, and
 * the redundancy is the reason a narrowing feed is hard to reach by
 * accident.
 */
describe("NC9: exploration survives strong performance evidence", () => {
  const options = recommendWhatToPostNext({
    mix: mixOf(20),
    topics: buildTopicModel([]),
    differentiation: analyzeDifferentiation([]),
    daysSinceLastPost: { x: 1 },
    platforms: ["x"],
    accountId: "a",
    nowIso: NOW,
    performance: {
      strongest: [
        { dimension: "archetype", value: "educational", label: "Educational", n: 40, median: 25 },
        { dimension: "hook", value: "statement", label: "Statement", n: 38, median: 22 },
      ],
      verdictPermitted: true,
      sampleSize: 60,
    },
  });

  it("still offers something untested alongside the winner", () => {
    expect(options.some((o) => o.kind === "exploit")).toBe(true);
    expect(options.some((o) => o.kind === "explore")).toBe(true);
  });

  it("suggests experiments even when the mix is well established", () => {
    const experiments = suggestExperiments({ mix: mixOf(20), postsPerWeek: 3, nowIso: NOW });
    expect(experiments.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// NC10 — introduce another independent similarity implementation
// ---------------------------------------------------------------------
describe("NC10: one similarity engine, and only one", () => {
  const FACADE = "core/intelligence/similarity.ts";

  /**
   * Where a similarity primitive is DEFINED, and why each is allowed.
   *
   * The canonical module for intelligence and strategy is
   * `core/intelligence/similarity.ts`, and it is a facade: it re-exports
   * jaccard/shingles/tokenize from the publishing-QA detector rather
   * than reimplementing them, which is why that file — not the facade —
   * is the definition site.
   *
   * This list is the guard. It may shrink; it may not grow. A new file
   * defining jaccard or shingles fails the test, which is exactly the
   * negative control: a fourth engine cannot appear unnoticed.
   */
  const DEFINITION_SITES: Record<string, string> = {
    "core/publishing-qa/near-duplicate.ts":
      "the one real implementation; the intelligence facade re-exports it",
    "core/platform-native/cross-platform-differentiation.ts":
      "pre-existing draft-time hook check inside publishing QA, a subsystem this milestone was told not to modify",
  };

  it("adds no new similarity implementation", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const relative = path.relative(SRC, file);
      if (DEFINITION_SITES[relative]) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/function\s+jaccard\s*\(/.test(source)) offenders.push(`${relative}: jaccard`);
      if (/function\s+shingles?\s*\(/.test(source)) offenders.push(`${relative}: shingles`);
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("keeps the list honest — every entry still defines one", () => {
    for (const relative of Object.keys(DEFINITION_SITES)) {
      const source = stripComments(readFileSync(path.join(SRC, relative), "utf8"));
      expect(
        /function\s+(jaccard|shingles?)\s*\(/.test(source),
        `${relative} no longer defines a similarity primitive — remove it from the list`,
      ).toBe(true);
    }
  });

  it("keeps the canonical module a facade, not a reimplementation", () => {
    const source = readFileSync(path.join(SRC, FACADE), "utf8");
    expect(source).toMatch(/from "@\/core\/publishing-qa\/near-duplicate"/);
    expect(stripComments(source)).not.toMatch(/function\s+(jaccard|shingles)\s*\(/);
  });

  it("makes every strategy consumer import the canonical module", () => {
    const consumers = strategySources().filter(({ source }) =>
      /similarity|jaccard|shingle/i.test(stripComments(source)),
    );
    expect(consumers.length).toBeGreaterThan(0);
    for (const { file, source } of consumers) {
      expect(source, `${file} computes similarity locally`).toMatch(
        /from "@\/core\/intelligence\/(similarity|repetition)"/,
      );
    }
  });
});

// ---------------------------------------------------------------------
// Cross-cutting: the layer states its own category for every claim
// ---------------------------------------------------------------------
describe("evidence categories are never collapsed", () => {
  it("labels every piece of evidence attached to an option", () => {
    const options = recommendWhatToPostNext({
      mix: mixOf(12),
      topics: buildTopicModel([]),
      differentiation: analyzeDifferentiation([]),
      daysSinceLastPost: { x: 4 },
      platforms: ["x"],
      accountId: "a",
      nowIso: NOW,
      performance: null,
    });
    for (const option of options) {
      expect(option.evidence.length).toBeGreaterThan(0);
      for (const evidence of option.evidence) {
        expect(["fact", "observation", "suggestion", "experiment", "ai_interpretation"]).toContain(
          evidence.category,
        );
        expect(evidence.source.length).toBeGreaterThan(0);
      }
    }
  });
});
