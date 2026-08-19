/**
 * Statistical safety contract (PURE).
 *
 * Social engagement is heavy-tailed. For the power-law exponents typical
 * of social data the variance is not a defined quantity, so a mean ± SD
 * is not merely noisy — it is describing something that does not exist.
 * Every comparator here is therefore rank-based: medians and order
 * statistics, never arithmetic means.
 *
 * The sample gates below are the hard part of this module, and they are
 * deliberately conservative because the data they guard is tiny. Signal
 * has 15 X and 13 Bluesky publications total, 8 of the 12 readable ones
 * sit at exactly zero engagement, and the primary Bluesky identity has
 * one follower. Under those conditions almost every question an operator
 * wants answered has the same correct answer: not yet.
 *
 * Returning `insufficient_data` is a SUCCESSFUL result. The failure mode
 * this module exists to prevent is a confident-looking number computed
 * from four posts.
 *
 * Pure module — no I/O, no clock, no randomness.
 */

/**
 * Below this, a median is not reportable at all: a distribution-free
 * 95% interval around the median needs n≥6 before it is even defined.
 */
export const MIN_N_FOR_MEDIAN = 6;

/** Quartiles need more points than a median before they mean anything. */
export const MIN_N_FOR_QUARTILES = 13;

/**
 * Below this, no comparative verdict is permitted. Rank-based power
 * analysis puts ~23/group at 80% power for a LARGE effect and ~49 for a
 * medium one; 25 is the floor, not a comfortable sample.
 */
export const MIN_N_FOR_VERDICT = 25;

export type SampleVerdict =
  | "insufficient_data"
  | "descriptive_only"
  | "verdict_permitted";

export function classifySample(n: number): SampleVerdict {
  if (!Number.isFinite(n) || n < MIN_N_FOR_MEDIAN) return "insufficient_data";
  if (n < MIN_N_FOR_VERDICT) return "descriptive_only";
  return "verdict_permitted";
}

// ---------------------------------------------------------------------
// order statistics
// ---------------------------------------------------------------------

/**
 * Quantile by linear interpolation between order statistics (the R type-7
 * / numpy default). Returns null for an empty sample rather than 0 — an
 * empty distribution has no median, and 0 would be a fabricated value.
 */
export function quantile(values: readonly number[], q: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const pos = (clean.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (pos - lower);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

export interface SampleSummary {
  n: number;
  verdict: SampleVerdict;
  /** Null when n < MIN_N_FOR_MEDIAN — not zero, not the mean. */
  median: number | null;
  /** Null when n < MIN_N_FOR_QUARTILES. */
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  /** Share of the sample that is exactly zero. */
  zeroShare: number | null;
  /** Human-readable reasons this summary should be read cautiously. */
  warnings: string[];
}

/**
 * Summarise a sample under the gates.
 *
 * Note what is absent: no mean, no standard deviation, no confidence
 * interval. Reporting a mean here would invite exactly the comparison
 * the distribution cannot support.
 */
export function summarizeSample(values: readonly number[]): SampleSummary {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  const verdict = classifySample(n);
  const warnings: string[] = [];

  const canMedian = n >= MIN_N_FOR_MEDIAN;
  const canQuartiles = n >= MIN_N_FOR_QUARTILES;

  if (!canMedian) {
    warnings.push(
      `Only ${n} measured post${n === 1 ? "" : "s"} — below the ${MIN_N_FOR_MEDIAN} needed to report a median.`,
    );
  } else if (!canQuartiles) {
    warnings.push(
      `${n} measured posts — enough for a median, below the ${MIN_N_FOR_QUARTILES} needed for quartiles.`,
    );
  }
  if (canMedian && verdict === "descriptive_only") {
    warnings.push(
      `Descriptive only: ${n} posts is below the ${MIN_N_FOR_VERDICT} needed to draw a conclusion.`,
    );
  }

  const zeroShare = n > 0 ? clean.filter((v) => v === 0).length / n : null;
  if (zeroShare != null && zeroShare >= 0.5 && n > 0) {
    warnings.push(
      `${Math.round(zeroShare * 100)}% of measured posts have zero engagement, so rank comparisons are mostly ties and carry little information.`,
    );
  }

  return {
    n,
    verdict,
    median: canMedian ? median(clean) : null,
    p25: canQuartiles ? quantile(clean, 0.25) : null,
    p75: canQuartiles ? quantile(clean, 0.75) : null,
    min: n > 0 ? Math.min(...clean) : null,
    max: n > 0 ? Math.max(...clean) : null,
    zeroShare,
    warnings,
  };
}

// ---------------------------------------------------------------------
// group comparison
// ---------------------------------------------------------------------

/** Confounders that are uncontrolled in any observational comparison of
 *  one account's own posting history. Attached to EVERY comparison. */
export const STANDARD_CONFOUNDERS = [
  "posting time and day of week",
  "content type and topic",
  "post length and link presence",
  "audience size at the time of posting",
  "novelty of the account and of the format",
  "the operator's own choice of which posts to route each way",
] as const;

export interface GroupInput {
  label: string;
  values: readonly number[];
}

export interface GroupComparison {
  groups: Array<{ label: string; summary: SampleSummary }>;
  /** The weakest verdict across groups — a comparison is only as strong
   *  as its smallest arm. */
  verdict: SampleVerdict;
  /** Difference of medians, ONLY when both medians exist. Descriptive. */
  medianDifference: number | null;
  warnings: string[];
  /** Always true for observational data. Kept explicit so no consumer
   *  can forget it. */
  causalClaimPermitted: false;
  summary: string;
}

/**
 * Compare groups descriptively.
 *
 * There is no significance test here on purpose. With one account, an
 * operator-chosen exposure and a corpus this small, a p-value would
 * dress up a comparison whose groups differ in time period, topic and
 * format simultaneously. The honest output is two medians, two sample
 * sizes, and the list of things that were not controlled.
 */
export function compareGroups(groups: readonly GroupInput[]): GroupComparison {
  const summarised = groups.map((g) => ({
    label: g.label,
    summary: summarizeSample(g.values),
  }));

  const verdicts = summarised.map((g) => g.summary.verdict);
  const verdict: SampleVerdict = verdicts.includes("insufficient_data")
    ? "insufficient_data"
    : verdicts.includes("descriptive_only")
      ? "descriptive_only"
      : "verdict_permitted";

  const warnings: string[] = [];
  for (const g of summarised) {
    for (const w of g.summary.warnings) warnings.push(`${g.label}: ${w}`);
  }

  const medians = summarised.map((g) => g.summary.median);
  const medianDifference =
    summarised.length === 2 && medians[0] != null && medians[1] != null
      ? round2(medians[1]! - medians[0]!)
      : null;

  if (verdict !== "verdict_permitted") {
    warnings.push(
      "This comparison is descriptive. It does not show that one publication " +
        "method causes different performance.",
    );
  }
  warnings.push(
    `Groups are not matched on: ${STANDARD_CONFOUNDERS.join(", ")}.`,
  );

  return {
    groups: summarised,
    verdict,
    medianDifference,
    warnings,
    causalClaimPermitted: false,
    summary: describeComparison(summarised, verdict),
  };
}

/**
 * Render a comparison in language that cannot be read as causal.
 *
 * Every sentence attaches its sample size, and the verb is always
 * observational ("recorded", "measured") rather than causal ("caused",
 * "penalised", "because"). A test asserts the forbidden vocabulary never
 * appears in anything this module emits.
 */
export function describeComparison(
  groups: Array<{ label: string; summary: SampleSummary }>,
  verdict: SampleVerdict,
): string {
  if (groups.length === 0) return "No groups to compare.";

  const parts = groups.map((g) => {
    const { n, median: med } = g.summary;
    if (n === 0) return `${g.label}: no measured posts`;
    if (med == null) {
      return `${g.label}: ${n} measured post${n === 1 ? "" : "s"} (too few for a median)`;
    }
    return `${g.label}: median ${formatNumber(med)}, n=${n}`;
  });

  const head = parts.join(" · ");

  switch (verdict) {
    case "insufficient_data":
      return `${head}. Not enough measured posts to compare — Signal does not have enough data yet.`;
    case "descriptive_only":
      return `${head}. Descriptive only: too few posts to draw a conclusion, and the groups differ in ways that were not controlled.`;
    default:
      return `${head}. Sample sizes permit a comparison, but this is observational data from one account: differences may reflect what was posted and when, not the publication method.`;
  }
}

// ---------------------------------------------------------------------
// trend
// ---------------------------------------------------------------------

export type TrendDirection = "improving" | "stable" | "declining" | "insufficient_data";

export interface TrendResult {
  direction: TrendDirection;
  /** Median of the recent window, when reportable. */
  recentMedian: number | null;
  /** Median of the prior window, when reportable. */
  priorMedian: number | null;
  n: number;
  warnings: string[];
  summary: string;
}

/**
 * A deliberately blunt trend classifier: split the series in half, compare
 * medians, and require BOTH halves to clear the median gate.
 *
 * The minimum-effect threshold exists because regression to the mean will
 * produce a "decline" after any high-performing stretch. A change smaller
 * than the threshold is reported as stable rather than as a direction.
 *
 * `values` must be ordered oldest → newest.
 */
/**
 * Below this median, the series is at the engagement floor and a
 * "change" is one or two individual interactions. Movement from a median
 * of 0 to 0.5 is a single like on a single post; calling that a decline
 * would manufacture exactly the finding an operator already suspects.
 */
export const MIN_MEANINGFUL_MEDIAN = 1;

export function classifyTrend(
  values: readonly number[],
  options: { minRelativeChange?: number } = {},
): TrendResult {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  const minRelativeChange = options.minRelativeChange ?? 0.2;

  // Each half must independently clear the median gate.
  if (n < MIN_N_FOR_MEDIAN * 2) {
    return {
      direction: "insufficient_data",
      recentMedian: null,
      priorMedian: null,
      n,
      warnings: [
        `${n} measured posts — a trend needs at least ${MIN_N_FOR_MEDIAN * 2} so each half can support a median.`,
      ],
      summary: "Not enough measured posts to say whether performance is trending.",
    };
  }

  const mid = Math.floor(n / 2);
  const prior = clean.slice(0, mid);
  const recent = clean.slice(n - mid);
  const priorMedian = median(prior);
  const recentMedian = median(recent);

  if (priorMedian == null || recentMedian == null) {
    return {
      direction: "insufficient_data",
      recentMedian,
      priorMedian,
      n,
      warnings: ["One half of the series had no reportable median."],
      summary: "Not enough measured posts to say whether performance is trending.",
    };
  }

  const warnings: string[] = [
    "A single account's series cannot separate a real change from normal variation or regression to the mean.",
  ];

  // At the floor, a "change" is one or two individual interactions.
  if (Math.max(priorMedian, recentMedian) < MIN_MEANINGFUL_MEDIAN) {
    const bothZero = priorMedian === 0 && recentMedian === 0;
    return {
      direction: "stable",
      recentMedian,
      priorMedian,
      n,
      warnings: [
        ...warnings,
        bothZero
          ? "Both halves have a median of zero, so there is no movement to describe."
          : `Median engagement is below ${MIN_MEANINGFUL_MEDIAN} interaction in both halves, so any difference here is one or two individual interactions rather than a trend.`,
      ],
      summary: bothZero
        ? "Median engagement is zero across the whole period — there is no trend to report."
        : `Median engagement is at the floor (${formatNumber(priorMedian)} then ${formatNumber(recentMedian)}); too small to describe as a trend.`,
    };
  }

  const denominator = Math.max(priorMedian, 1);
  const relative = (recentMedian - priorMedian) / denominator;

  let direction: TrendDirection = "stable";
  if (relative >= minRelativeChange) direction = "improving";
  else if (relative <= -minRelativeChange) direction = "declining";

  return {
    direction,
    recentMedian,
    priorMedian,
    n,
    warnings,
    summary:
      `Median of the most recent ${mid} posts is ${formatNumber(recentMedian)} ` +
      `against ${formatNumber(priorMedian)} for the previous ${prior.length}. ` +
      `Recorded as ${direction}.`,
  };
}

// ---------------------------------------------------------------------
// language guard
// ---------------------------------------------------------------------

/**
 * Vocabulary that turns an observation into a causal claim. Used by the
 * invariant tests to scan everything this subsystem emits.
 *
 * "X penalizes Signal API posts by 38%" is the exact sentence this
 * milestone must never produce.
 */
export const FORBIDDEN_CAUSAL_PATTERNS: RegExp[] = [
  /\bpenali[sz]/i,
  /\bshadow ?ban/i,
  /\bsuppress/i,
  /\bthrottl(?:es|ed|ing) (?:your|our|the) (?:reach|account|posts)/i,
  /\bbecause (?:of )?(?:the )?api\b/i,
  /\bcaused by\b/i,
  /\bproves?\b/i,
  /\bdemonstrates? that\b/i,
  /\bflagged (?:you|us|the account) as\b/i,
  /\bclassified (?:you|us|this) as spam\b/i,
];

/** True when text contains a causal or provider-classification claim. */
export function containsCausalClaim(text: string): boolean {
  return FORBIDDEN_CAUSAL_PATTERNS.some((p) => p.test(text));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
