import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CAUSAL_PATTERNS,
  MIN_N_FOR_MEDIAN,
  MIN_N_FOR_QUARTILES,
  MIN_N_FOR_VERDICT,
  classifySample,
  classifyTrend,
  compareGroups,
  containsCausalClaim,
  median,
  quantile,
  summarizeSample,
} from "./statistics";

/** The real Bluesky engagement series, oldest → newest. */
const REAL_BLUESKY = [1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0];

describe("order statistics", () => {
  it("computes a median without touching the mean", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    // A single 1000 would drag a mean to 201; the median ignores it.
    expect(median([0, 0, 0, 0, 1000])).toBe(0);
  });

  it("returns null for an empty sample rather than zero", () => {
    // An empty distribution has no median. Zero would be fabricated.
    expect(median([])).toBeNull();
    expect(quantile([], 0.25)).toBeNull();
  });

  it("interpolates quartiles between order statistics", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });

  it("ignores non-finite values instead of poisoning the result", () => {
    expect(median([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toBe(2);
  });
});

describe("sample gates", () => {
  it("classifies by the documented thresholds", () => {
    expect(classifySample(0)).toBe("insufficient_data");
    expect(classifySample(MIN_N_FOR_MEDIAN - 1)).toBe("insufficient_data");
    expect(classifySample(MIN_N_FOR_MEDIAN)).toBe("descriptive_only");
    expect(classifySample(MIN_N_FOR_VERDICT - 1)).toBe("descriptive_only");
    expect(classifySample(MIN_N_FOR_VERDICT)).toBe("verdict_permitted");
  });

  it("withholds the median below the median gate", () => {
    // NEGATIVE CONTROL (required): a comparative verdict at n<6 must not
    // be available. There is no number to render at all.
    const s = summarizeSample([1, 2, 3, 4, 5]);
    expect(s.n).toBe(5);
    expect(s.verdict).toBe("insufficient_data");
    expect(s.median).toBeNull();
    expect(s.p25).toBeNull();
    expect(s.warnings.join(" ")).toContain("below the 6 needed");
  });

  it("gives a median but withholds quartiles between the two gates", () => {
    const s = summarizeSample([0, 1, 2, 3, 4, 5, 6]);
    expect(s.verdict).toBe("descriptive_only");
    expect(s.median).toBe(3);
    expect(s.p25).toBeNull();
    expect(s.p75).toBeNull();
    expect(s.warnings.join(" ")).toContain(`below the ${MIN_N_FOR_QUARTILES} needed for quartiles`);
  });

  it("reports quartiles once the sample supports them", () => {
    const s = summarizeSample(Array.from({ length: 13 }, (_, i) => i));
    expect(s.median).toBe(6);
    expect(s.p25).toBe(3);
    expect(s.p75).toBe(9);
  });

  it("never reports a mean or a standard deviation", () => {
    const s = summarizeSample([1, 2, 3, 4, 5, 6, 7]);
    expect(s).not.toHaveProperty("mean");
    expect(s).not.toHaveProperty("avg");
    expect(s).not.toHaveProperty("stdDev");
  });

  it("warns when the sample is mostly zeros, so ranks are mostly ties", () => {
    const s = summarizeSample(REAL_BLUESKY);
    expect(s.n).toBe(12);
    expect(s.median).toBe(0);
    expect(s.zeroShare).toBeCloseTo(8 / 12, 5);
    expect(s.warnings.join(" ")).toContain("mostly ties");
  });
});

describe("the real production comparison", () => {
  // Signal-published n=12 (median 0) vs native n=6 (median 0.5). The
  // observed difference is real; reporting it as a finding is not.
  const comparison = compareGroups([
    { label: "Published by Signal", values: REAL_BLUESKY },
    { label: "Published by a person", values: [1, 0, 2, 0, 0, 6] },
  ]);

  it("is never permitted to produce a verdict at these sample sizes", () => {
    expect(comparison.verdict).toBe("descriptive_only");
    expect(comparison.causalClaimPermitted).toBe(false);
  });

  it("reports both medians with their sample sizes attached", () => {
    expect(comparison.summary).toContain("median 0, n=12");
    expect(comparison.summary).toContain("median 0.5, n=6");
  });

  it("states plainly that it is not a causal finding", () => {
    expect(comparison.warnings.join(" ")).toContain(
      "does not show that one publication method causes different performance",
    );
  });

  it("always lists the uncontrolled confounders", () => {
    const text = comparison.warnings.join(" ");
    for (const c of ["posting time", "content type", "audience size", "operator's own choice"]) {
      expect(text).toContain(c);
    }
  });

  it("takes the WEAKEST arm's verdict — a comparison is only as strong as its smallest group", () => {
    const lopsided = compareGroups([
      { label: "big", values: Array.from({ length: 100 }, () => 5) },
      { label: "tiny", values: [1, 2] },
    ]);
    expect(lopsided.verdict).toBe("insufficient_data");
  });

  it("refuses a median difference when either arm lacks a median", () => {
    const c = compareGroups([
      { label: "a", values: [1, 2] },
      { label: "b", values: [1, 2, 3, 4, 5, 6] },
    ]);
    expect(c.medianDifference).toBeNull();
  });
});

describe("no-causal-overclaim guard", () => {
  // NEGATIVE CONTROL (required): causal API-penalty language must fail.
  it("recognises the exact sentence this milestone must never produce", () => {
    expect(containsCausalClaim("X penalizes Signal API posts by 38%")).toBe(true);
    expect(containsCausalClaim("Your account is shadowbanned")).toBe(true);
    expect(containsCausalClaim("The decline was caused by API publishing")).toBe(true);
    expect(containsCausalClaim("This proves the platform suppresses automation")).toBe(true);
    expect(containsCausalClaim("The provider classified this as spam")).toBe(true);
  });

  it("permits honest descriptive wording", () => {
    expect(
      containsCausalClaim(
        "Native manual posts: median 2140 impressions, n=8. Signal API posts: median 1320, n=11. " +
          "Groups differ in content type and posting time.",
      ),
    ).toBe(false);
    expect(containsCausalClaim("Bluesky reports no impressions metric.")).toBe(false);
  });

  it("nothing this module emits contains a causal claim", () => {
    const emitted: string[] = [];
    for (const values of [[], [1], REAL_BLUESKY, Array.from({ length: 40 }, (_, i) => i)]) {
      const s = summarizeSample(values);
      emitted.push(...s.warnings);
      const t = classifyTrend(values);
      emitted.push(t.summary, ...t.warnings);
    }
    const c = compareGroups([
      { label: "Published by Signal", values: REAL_BLUESKY },
      { label: "Published by a person", values: [1, 0, 2, 0, 0, 6] },
    ]);
    emitted.push(c.summary, ...c.warnings);

    for (const text of emitted) {
      expect(containsCausalClaim(text), `emitted: ${text}`).toBe(false);
    }
  });

  it("has patterns that actually compile and match", () => {
    expect(FORBIDDEN_CAUSAL_PATTERNS.length).toBeGreaterThan(5);
    for (const p of FORBIDDEN_CAUSAL_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});

describe("trend classification", () => {
  it("declines to classify a trend without two half-samples", () => {
    const t = classifyTrend([1, 1, 0, 2, 0, 0, 0, 0]);
    expect(t.direction).toBe("insufficient_data");
    expect(t.summary).toContain("Not enough measured posts");
  });

  it("refuses to call the real Bluesky series a decline", () => {
    // Prior half median 0.5, recent half median 0 — a difference of ONE
    // like on ONE post. Reporting that as declining reach would
    // manufacture the exact finding the operator already suspects.
    const t = classifyTrend(REAL_BLUESKY);
    expect(t.direction).toBe("stable");
    expect(t.summary).toContain("at the floor");
  });

  it("reports a flat-zero series as stable, not as decline", () => {
    // Both halves at the floor is not a trend, and calling it one would
    // manufacture the very finding the operator suspects.
    const t = classifyTrend(Array.from({ length: 12 }, () => 0));
    expect(t.direction).toBe("stable");
    expect(t.summary).toContain("no trend to report");
  });

  it("requires a minimum effect so regression to the mean is not a decline", () => {
    const values = [10, 10, 10, 10, 10, 10, 9, 10, 9, 10, 10, 9];
    expect(classifyTrend(values).direction).toBe("stable");
  });

  it("recognises a genuine, large movement in both directions", () => {
    expect(
      classifyTrend([1, 1, 1, 1, 1, 1, 10, 10, 10, 10, 10, 10]).direction,
    ).toBe("improving");
    expect(
      classifyTrend([10, 10, 10, 10, 10, 10, 1, 1, 1, 1, 1, 1]).direction,
    ).toBe("declining");
  });

  it("always warns that one account's series cannot separate signal from noise", () => {
    const t = classifyTrend([1, 1, 1, 1, 1, 1, 10, 10, 10, 10, 10, 10]);
    expect(t.warnings.join(" ")).toContain("regression to the mean");
  });
});

describe("insufficient_data is a successful result", () => {
  it("says so in operator language rather than showing an empty number", () => {
    const c = compareGroups([
      { label: "Published by Signal", values: [1, 2] },
      { label: "Published by a person", values: [] },
    ]);
    expect(c.summary).toContain("Signal does not have enough data yet");
    expect(c.summary).not.toContain("NaN");
    expect(c.summary).not.toMatch(/\bmedian 0\b/);
  });
});
