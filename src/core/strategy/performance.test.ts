import { describe, expect, it } from "vitest";
import { containsCausalClaim, MIN_N_FOR_MEDIAN, MIN_N_FOR_VERDICT } from "@/core/intelligence/statistics";
import { classifyArchetype, classifyCta, classifyHook } from "./classifiers";
import { extractFeatures } from "./content-features";
import { containsStrategyOverclaim, classified } from "./evidence";
import {
  analyzePerformance,
  compareDimensions,
  toRecommendationPerformance,
  type MeasuredPost,
} from "./performance";

function post(
  body: string,
  engagement: number | null,
  options: { platform?: string; ageWindow?: string | null } = {},
): MeasuredPost {
  const features = extractFeatures({
    id: `p-${body.slice(0, 8)}-${engagement}`,
    platform: options.platform ?? "x",
    accountId: "a",
    handle: "h",
    publishedAt: "2026-06-01T12:00:00Z",
    title: null,
    body,
    linkUrl: null,
  });
  return {
    features,
    archetype: classifyArchetype(features, body),
    hook: classifyHook(features),
    cta: classifyCta(features, body),
    topic: classified("analytics", "moderate", ["test fixture"]),
    engagement,
    ageWindow: options.ageWindow === undefined ? "24h" : options.ageWindow,
  };
}

/** n identical-shape posts, so a bucket can be filled to a chosen size. */
function bucketOf(n: number, body: string, value: number): MeasuredPost[] {
  return Array.from({ length: n }, (_, i) => post(`${body} ${i}`, value));
}

describe("no measurements at all", () => {
  const posts = [post("Evidence needs a loop.", null), post("Dashboards are noisy.", null)];
  const evidence = analyzePerformance(posts);

  it("reports nothing measured rather than zero engagement", () => {
    expect(evidence.measuredCount).toBe(0);
    expect(evidence.unmeasuredCount).toBe(2);
    expect(evidence.overall.median).toBeNull();
    expect(evidence.level).toBe("none");
  });

  it("says so in words an operator can act on", () => {
    expect(evidence.summary).toContain("No post has been measured yet");
    expect(evidence.observations.some((o) => o.category === "observation")).toBe(true);
  });

  it("hands the recommendation engine null, not an empty result", () => {
    // An empty-but-present object would read as "we measured, and found
    // nothing" — which is the opposite of the truth.
    expect(toRecommendationPerformance(evidence)).toBeNull();
  });
});

describe("unmeasured posts are excluded, never counted as zero", () => {
  const posts = [
    post("Measured one.", 4),
    post("Measured two.", 6),
    post("Never measured.", null),
    post("Also never measured.", null),
  ];
  const evidence = analyzePerformance(posts);

  it("keeps them out of the sample", () => {
    expect(evidence.overall.n).toBe(2);
    expect(evidence.measuredCount).toBe(2);
    expect(evidence.unmeasuredCount).toBe(2);
  });

  it("tells the operator they were excluded", () => {
    const text = evidence.observations.map((o) => o.statement).join(" ");
    expect(text).toContain("excluded from every comparison rather than counted as zero");
  });

  it("would have produced a different median had it counted them as zero", () => {
    // median([4,6]) = 5 ; median([0,0,4,6]) = 2. The distinction matters.
    const asZero = analyzePerformance([
      post("Measured one.", 4),
      post("Measured two.", 6),
      post("Never measured.", 0),
      post("Also never measured.", 0),
    ]);
    expect(asZero.overall.n).toBe(4);
    expect(evidence.overall.n).not.toBe(asZero.overall.n);
  });
});

describe("the sample gates", () => {
  it("refuses a median below the threshold", () => {
    const evidence = analyzePerformance(bucketOf(MIN_N_FOR_MEDIAN - 1, "Short sample", 3));
    expect(evidence.overall.median).toBeNull();
    expect(evidence.level).toBe("none");
    expect(evidence.summary).toContain(`below the ${MIN_N_FOR_MEDIAN}`);
    expect(evidence.strongest).toHaveLength(0);
  });

  it("reports a median with an explicit small-sample caveat between the gates", () => {
    const evidence = analyzePerformance(bucketOf(MIN_N_FOR_MEDIAN, "Mid sample", 3));
    expect(evidence.level).toBe("limited");
    expect(evidence.overall.median).toBe(3);
    const stated = evidence.byArchetype.map((d) => d.statement).join(" ");
    expect(stated).toContain("small");
  });

  it("permits the stronger wording only above the verdict gate", () => {
    const evidence = analyzePerformance(bucketOf(MIN_N_FOR_VERDICT, "Large sample", 3));
    expect(evidence.level).toBe("stronger");
    expect(evidence.overall.verdict).toBe("verdict_permitted");
  });

  it("never lets a bucket outrank the gate it sits below", () => {
    // Five high-scoring posts must not beat twenty-six low-scoring ones
    // into `strongest`, because five is not a reportable sample.
    const evidence = analyzePerformance([
      ...bucketOf(5, "What changed this week?", 500),
      ...bucketOf(MIN_N_FOR_VERDICT + 1, "Plain statement", 1),
    ]);
    for (const entry of evidence.strongest) {
      expect(entry.n).toBeGreaterThanOrEqual(MIN_N_FOR_MEDIAN);
    }
  });
});

describe("like-for-like windows", () => {
  it("compares only readings taken at a comparable post age", () => {
    const posts = [
      ...bucketOf(6, "Twenty four hour reading", 5),
      ...Array.from({ length: 6 }, (_, i) =>
        post(`Seven day reading ${i}`, 90, { ageWindow: "7d" }),
      ),
    ];
    const all = analyzePerformance(posts);
    const day = analyzePerformance(posts, { ageWindow: "24h" });
    expect(all.overall.n).toBe(12);
    expect(day.overall.n).toBe(6);
    expect(day.overall.median).toBe(5);
  });
});

describe("two-group comparison delegates to the established comparator", () => {
  const posts = [
    ...bucketOf(3, "Group A statement", 2),
    ...Array.from({ length: 3 }, (_, i) => post(`Have you tried this? ${i}`, 9)),
  ];

  it("refuses a verdict on tiny groups", () => {
    const result = compareDimensions(posts, "archetype", "industry_commentary", "question");
    expect(result.permitted).toBe(false);
  });

  it("carries the confounder list rather than a second one", () => {
    const result = compareDimensions(posts, "archetype", "industry_commentary", "question");
    expect(result.warnings.join(" ")).toContain("not matched on");
  });

  it("returns insufficient_data when one side has no posts at all", () => {
    const result = compareDimensions(posts, "archetype", "industry_commentary", "case_study");
    expect(result.permitted).toBe(false);
  });
});

describe("claim safety", () => {
  const evidence = analyzePerformance([
    ...bucketOf(MIN_N_FOR_VERDICT + 2, "Plain observation", 7),
    ...Array.from({ length: 8 }, (_, i) => post(`What changed here? ${i}`, 2)),
  ]);
  const everything = [
    evidence.summary,
    ...evidence.observations.map((o) => o.statement),
    ...[...evidence.byArchetype, ...evidence.byHook, ...evidence.byCta, ...evidence.byLengthBand].map(
      (d) => d.statement,
    ),
  ];

  it("emits no causal claim anywhere, at any evidence level", () => {
    for (const text of everything) {
      expect(containsCausalClaim(text), text).toBe(false);
    }
  });

  it("emits no strategy overclaim anywhere", () => {
    for (const text of everything) {
      expect(containsStrategyOverclaim(text), text).toBe(false);
    }
  });

  it("attaches a sample size to every reportable statement", () => {
    for (const entry of evidence.strongest) {
      expect(entry.statement).toMatch(/\d+ measured[\w ]*post/);
    }
  });
});

describe("the recommendation adapter", () => {
  it("passes only reportable buckets through", () => {
    const evidence = analyzePerformance([
      ...bucketOf(MIN_N_FOR_MEDIAN, "Reportable bucket", 8),
      ...bucketOf(2, "Have you seen this?", 400),
    ]);
    const adapted = toRecommendationPerformance(evidence);
    expect(adapted).not.toBeNull();
    for (const entry of adapted!.strongest) {
      expect(entry.n).toBeGreaterThanOrEqual(MIN_N_FOR_MEDIAN);
    }
  });

  it("does not claim a verdict below the verdict gate", () => {
    const evidence = analyzePerformance(bucketOf(MIN_N_FOR_MEDIAN, "Between gates", 4));
    expect(toRecommendationPerformance(evidence)!.verdictPermitted).toBe(false);
  });
});
