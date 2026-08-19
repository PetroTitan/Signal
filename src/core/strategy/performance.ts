/**
 * Performance-aware evidence (PURE).
 *
 * Connects content features to measured engagement, under the sample
 * gates already established. This module is the ONLY place in the
 * strategy layer that may make a comparative claim, and it may only make
 * one the gates permit.
 *
 * IT REVIVES compareGroups. The Phase 0 audit found the entire
 * reconciliation subsystem had zero production callers, which
 * transitively killed `compareGroups` — the codebase's only rigorous
 * comparator, complete with its confounder list. Rather than write a
 * second one, this module uses it.
 *
 * THREE EVIDENCE LEVELS, and the wording differs at each:
 *
 *   no comparable data  "You have not published enough comparable posts
 *                        to evaluate this."
 *   limited             "Among 4 question-led posts, replies were higher
 *                        than your recent baseline. The sample is small."
 *   stronger            "Educational posts have a higher 24h median
 *                        reply count across 14 comparable posts."
 *
 * Note what none of them says: that the format CAUSED the difference.
 *
 * Pure module — no I/O, no clock.
 */

import {
  MIN_N_FOR_MEDIAN,
  MIN_N_FOR_VERDICT,
  compareGroups,
  summarizeSample,
  type SampleVerdict,
} from "@/core/intelligence/statistics";
import type { Archetype, CtaType, HookType } from "./classifiers";
import { ARCHETYPE_LABELS, CTA_LABELS, HOOK_LABELS } from "./classifiers";
import type { ContentStrategyFeatures } from "./content-features";
import type { Classified } from "./evidence";
import { SMALL_SAMPLE_CAVEAT, fact, observation, type EvidenceItem } from "./evidence";

export interface MeasuredPost {
  features: ContentStrategyFeatures;
  archetype: Classified<Archetype>;
  hook: Classified<HookType>;
  cta: Classified<CtaType>;
  topic: Classified<string>;
  /**
   * Total interactions, or null when the post has not been measured.
   * NULL IS NOT ZERO — an unmeasured post is excluded from the sample,
   * never counted as having received nothing.
   */
  engagement: number | null;
  /** Age window the reading was taken in, for like-for-like comparison. */
  ageWindow: string | null;
}

export type EvidenceLevel = "none" | "limited" | "stronger";

export interface DimensionPerformance {
  dimension: string;
  value: string;
  label: string;
  /** Measured posts in this bucket. Unmeasured posts are excluded. */
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  verdict: SampleVerdict;
  level: EvidenceLevel;
  /** The honest sentence for this bucket at this evidence level. */
  statement: string;
}

export interface PerformanceEvidence {
  /** Posts with a usable reading. */
  measuredCount: number;
  /** Posts with no reading at all. */
  unmeasuredCount: number;
  overall: {
    n: number;
    median: number | null;
    verdict: SampleVerdict;
  };
  byArchetype: DimensionPerformance[];
  byHook: DimensionPerformance[];
  byCta: DimensionPerformance[];
  byLengthBand: DimensionPerformance[];
  /** Buckets with enough evidence to report, best median first. */
  strongest: DimensionPerformance[];
  level: EvidenceLevel;
  observations: EvidenceItem[];
  summary: string;
}

export function analyzePerformance(
  posts: readonly MeasuredPost[],
  options: { ageWindow?: string | null } = {},
): PerformanceEvidence {
  // Like-for-like: only compare readings taken at a comparable post age.
  const inWindow = options.ageWindow
    ? posts.filter((p) => p.ageWindow === options.ageWindow)
    : posts;

  const measured = inWindow.filter((p) => p.engagement != null);
  const unmeasuredCount = inWindow.length - measured.length;
  const values = measured.map((p) => p.engagement!);
  const overall = summarizeSample(values);

  const byArchetype = bucket(measured, "archetype", (p) => p.archetype.value, ARCHETYPE_LABELS);
  const byHook = bucket(measured, "hook", (p) => p.hook.value, HOOK_LABELS);
  const byCta = bucket(measured, "CTA", (p) => p.cta.value, CTA_LABELS);
  const byLengthBand = bucket(measured, "length", (p) => p.features.lengthBand, {});

  const reportable = [...byArchetype, ...byHook, ...byCta, ...byLengthBand]
    .filter((d) => d.level !== "none" && d.median != null)
    .sort((a, b) => (b.median ?? 0) - (a.median ?? 0) || b.n - a.n);

  const level: EvidenceLevel =
    overall.n === 0
      ? "none"
      : overall.verdict === "verdict_permitted"
        ? "stronger"
        : overall.n >= MIN_N_FOR_MEDIAN
          ? "limited"
          : "none";

  const observations: EvidenceItem[] = [];
  if (measured.length === 0) {
    observations.push(
      observation(
        "No post has been measured yet, so nothing can be compared on performance.",
        "post_metrics",
      ),
    );
  } else {
    observations.push(
      fact(
        `${measured.length} of ${inWindow.length} post(s) have a usable measurement.`,
        "post_metrics",
      ),
    );
    if (unmeasuredCount > 0) {
      observations.push(
        observation(
          `${unmeasuredCount} post(s) have no measurement and are excluded from every comparison rather than counted as zero.`,
          "post_metrics",
        ),
      );
    }
    for (const w of overall.warnings) {
      observations.push(observation(w, "sample-size gate"));
    }
  }

  return {
    measuredCount: measured.length,
    unmeasuredCount,
    overall: { n: overall.n, median: overall.median, verdict: overall.verdict },
    byArchetype,
    byHook,
    byCta,
    byLengthBand,
    strongest: reportable,
    level,
    observations,
    summary: summarise(level, measured.length, reportable),
  };
}

function bucket(
  posts: readonly MeasuredPost[],
  dimension: string,
  pick: (p: MeasuredPost) => string,
  labels: Record<string, string>,
): DimensionPerformance[] {
  const groups = new Map<string, number[]>();
  for (const p of posts) {
    const key = pick(p);
    groups.set(key, [...(groups.get(key) ?? []), p.engagement!]);
  }

  return Array.from(groups.entries())
    .map(([value, values]) => {
      const s = summarizeSample(values);
      const level: EvidenceLevel =
        s.n === 0
          ? "none"
          : s.verdict === "verdict_permitted"
            ? "stronger"
            : s.n >= MIN_N_FOR_MEDIAN
              ? "limited"
              : "none";
      const label = labels[value] ?? value;
      return {
        dimension,
        value,
        label,
        n: s.n,
        median: s.median,
        p25: s.p25,
        p75: s.p75,
        verdict: s.verdict,
        level,
        statement: statementFor(dimension, label, s.n, s.median, level),
      };
    })
    .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/**
 * The wording IS the safety mechanism.
 *
 * At `none` the sentence describes the absence, not a result. At
 * `limited` it says what happened in this sample and calls it small. At
 * `stronger` it reports a median with an n — and still does not claim
 * the format caused it.
 */
function statementFor(
  dimension: string,
  label: string,
  n: number,
  median: number | null,
  level: EvidenceLevel,
): string {
  if (n === 0) {
    return `No measured posts with this ${dimension}, so there is nothing to compare.`;
  }
  if (level === "none" || median == null) {
    return `Only ${n} measured post(s) with ${label.toLowerCase()} — below the ${MIN_N_FOR_MEDIAN} needed to report a median.`;
  }
  if (level === "limited") {
    return `Among ${n} measured ${label.toLowerCase()} post(s), median engagement was ${median}. ${SMALL_SAMPLE_CAVEAT}`;
  }
  return `${label} posts have a median engagement of ${median} across ${n} measured post(s).`;
}

function summarise(
  level: EvidenceLevel,
  measured: number,
  reportable: readonly DimensionPerformance[],
): string {
  if (measured === 0) {
    return "No post has been measured yet. Recommendations below are based on what you have published, not on how it performed.";
  }
  if (level === "none") {
    return `${measured} measured post(s) — below the ${MIN_N_FOR_MEDIAN} needed to report a median for any dimension.`;
  }
  if (reportable.length === 0) {
    return `${measured} measured post(s), but no single content dimension has enough of them to compare.`;
  }
  const top = reportable[0];
  const caveat =
    level === "stronger"
      ? ""
      : ` ${SMALL_SAMPLE_CAVEAT}`;
  return `${measured} measured post(s). Highest median: ${top.label.toLowerCase()} at ${top.median} across ${top.n}.${caveat}`;
}

/**
 * A rigorous two-group comparison, delegating to the statistics module's
 * comparator so the confounder list and the verdict gate are the ones
 * already established rather than a second set.
 */
export function compareDimensions(
  posts: readonly MeasuredPost[],
  dimension: "archetype" | "hook" | "cta",
  valueA: string,
  valueB: string,
): {
  permitted: boolean;
  summary: string;
  warnings: string[];
} {
  const pick = (p: MeasuredPost) =>
    dimension === "archetype" ? p.archetype.value : dimension === "hook" ? p.hook.value : p.cta.value;

  const groupA = posts.filter((p) => pick(p) === valueA && p.engagement != null).map((p) => p.engagement!);
  const groupB = posts.filter((p) => pick(p) === valueB && p.engagement != null).map((p) => p.engagement!);

  const comparison = compareGroups([
    { label: valueA, values: groupA },
    { label: valueB, values: groupB },
  ]);

  return {
    permitted: comparison.verdict === "verdict_permitted",
    summary: comparison.summary,
    warnings: comparison.warnings,
  };
}

/** The threshold an operator can be told about. */
export const EVIDENCE_THRESHOLDS = {
  medianRequires: MIN_N_FOR_MEDIAN,
  verdictRequires: MIN_N_FOR_VERDICT,
} as const;

/**
 * Adapter to the recommendation engine's optional performance input.
 *
 * Returns null when nothing is reportable, so the engine takes its
 * no-performance path rather than receiving an empty-but-present object
 * that would read as "measured, and it found nothing".
 */
export function toRecommendationPerformance(
  evidence: PerformanceEvidence,
): {
  strongest: Array<{ dimension: string; value: string; label: string; n: number; median: number }>;
  verdictPermitted: boolean;
  sampleSize: number;
} | null {
  if (evidence.measuredCount === 0) return null;
  const strongest = evidence.strongest
    .filter((d) => d.median != null)
    .map((d) => ({
      dimension: d.dimension,
      value: d.value,
      label: d.label,
      n: d.n,
      median: d.median!,
    }));
  if (strongest.length === 0) return null;
  return {
    strongest,
    verdictPermitted: evidence.strongest.some((d) => d.verdict === "verdict_permitted"),
    sampleSize: evidence.measuredCount,
  };
}
