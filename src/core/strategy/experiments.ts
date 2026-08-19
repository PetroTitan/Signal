/**
 * Content experiment suggestions (PURE).
 *
 * An experiment here is a QUESTION plus the arithmetic of answering it,
 * never a hypothesis dressed as a prediction. The module's most useful
 * output is often the honest arithmetic itself: at 1.4 posts a week,
 * filling two arms of 6 takes about nine weeks, and reaching the verdict
 * gate would take most of a year. An operator who sees that can decide
 * whether the question is worth asking at all — which is a better
 * outcome than a dashboard that quietly promises an answer it cannot
 * deliver.
 *
 * WHAT THIS MODULE WILL NOT DO
 *   - state a hypothesis as a prediction ("questions will get more replies")
 *   - promise a causal readout at any sample size
 *   - schedule, enforce, or assign anything
 *   - block a post for being "outside the experiment"
 *
 * The readout an experiment promises is always descriptive, and when the
 * arithmetic says a verdict-grade answer is out of reach at the current
 * publishing rate, the suggestion SAYS SO instead of omitting it.
 *
 * Pure module — no I/O, no clock (the caller passes `nowIso`).
 */

import { MIN_N_FOR_MEDIAN, MIN_N_FOR_VERDICT } from "@/core/intelligence/statistics";
import type { Archetype, CtaType, HookType } from "./classifiers";
import type { ContentMix, UntestedDimension } from "./content-mix";
import { dominantDimensions, untestedDimensions } from "./content-mix";
import { fact, observation, type Confidence, type EvidenceItem } from "./evidence";
import type { PerformanceEvidence } from "./performance";

/** Two arms is the smallest comparison worth calling an experiment. */
export const ARMS = 2;

/**
 * Beyond this, the honest answer is "not at this publishing rate".
 * Nine months of disciplined alternation to answer one question about
 * hook style is not a plan; presenting it as one would be the dishonest
 * part.
 */
export const UNREALISTIC_AFTER_WEEKS = 26;

export type ExperimentStatus =
  | "ready"
  | "in_progress"
  | "descriptive_only_at_this_rate"
  | "not_realistic_at_this_rate";

export interface ExperimentSuggestion {
  id: string;
  title: string;
  /** A question, never a prediction. */
  question: string;
  /** The single thing that varies between arms. */
  vary: string;
  /** What to keep the same, so the arms stay comparable. */
  holdConstant: string[];
  arms: Array<{ label: string; postsSoFar: number }>;
  /** Posts PER ARM before a median can be reported at all. */
  postsPerArmForMedian: number;
  /** Posts per arm before any comparative verdict is permitted. */
  postsPerArmForVerdict: number;
  /** Posts still needed, across all arms, for the descriptive readout. */
  postsRemainingForDescriptive: number;
  /** Weeks at the current rate, or null when the rate is unknown. */
  weeksToDescriptive: number | null;
  weeksToVerdict: number | null;
  status: ExperimentStatus;
  /** Exactly what the operator will be told at the end. */
  readout: string;
  /** What the result will NOT establish. Always populated. */
  limitation: string;
  evidence: EvidenceItem[];
  confidence: Confidence;
  suggestedArchetype: Archetype | null;
  suggestedHook: HookType | null;
  suggestedCta: CtaType | null;
  /** Structural guarantee: an experiment is never a requirement. */
  blocking: false;
}

export interface ExperimentInput {
  mix: ContentMix;
  performance?: PerformanceEvidence | null;
  /** Posts per week across all platforms, or null when unknown. */
  postsPerWeek: number | null;
  nowIso: string;
}

/** Everything an arm must hold constant to stay comparable. */
const HOLD_CONSTANT = [
  "the platform (arms on different platforms are not comparable)",
  "roughly the same posting times",
  "roughly the same topic",
  "the measurement window used to read each post",
];

export function suggestExperiments(input: ExperimentInput): ExperimentSuggestion[] {
  const { mix, postsPerWeek } = input;
  if (mix.total === 0) return [];

  const untested = untestedDimensions(mix);
  const dominant = dominantDimensions(mix);
  const out: ExperimentSuggestion[] = [];

  // An untested dimension is the cleanest experiment available: one arm
  // already exists (everything published so far), the other is empty.
  for (const dimension of untested.slice(0, 3)) {
    out.push(fromUntested(dimension, mix, postsPerWeek));
  }

  // A dominant dimension is the other clean case: the operator has one
  // large arm and no comparison for it.
  if (dominant.length > 0) {
    const top = mix.archetypes.entries[0];
    if (top && top.count >= MIN_N_FOR_MEDIAN) {
      out.push(
        build({
          id: `experiment-contrast-${top.value}`,
          title: `A contrast for ${top.label.toLowerCase()} posts`,
          question: `Does anything read differently when a post is not ${top.label.toLowerCase()}?`,
          vary: `${top.label} versus a deliberately different archetype`,
          arms: [
            { label: top.label, postsSoFar: top.count },
            { label: "Anything else", postsSoFar: mix.total - top.count },
          ],
          postsPerWeek,
          evidence: [
            fact(
              `${top.count} of your last ${mix.total} posts are ${top.label.toLowerCase()}.`,
              "publish_history",
            ),
            observation(
              "A dimension with only one value cannot be compared against anything.",
              "content mix",
            ),
          ],
          confidence: "moderate",
          suggestedArchetype: null,
          suggestedHook: null,
          suggestedCta: null,
        }),
      );
    }
  }

  // Once measurement exists, the near-miss buckets are worth naming:
  // a dimension one or two posts short of reportable is the cheapest
  // question in the list.
  const nearMiss = (input.performance?.strongest ?? [])
    .concat(
      input.performance
        ? [
            ...input.performance.byArchetype,
            ...input.performance.byHook,
            ...input.performance.byCta,
          ]
        : [],
    )
    .filter((d) => d.n > 0 && d.n < MIN_N_FOR_MEDIAN);

  const seen = new Set<string>();
  for (const bucket of nearMiss) {
    const key = `${bucket.dimension}:${bucket.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= 5) break;
    const needed = MIN_N_FOR_MEDIAN - bucket.n;
    out.push(
      build({
        id: `experiment-complete-${bucket.dimension}-${bucket.value}`,
        title: `${needed} more ${bucket.label.toLowerCase()} post(s) to make it readable`,
        question: `What is the median engagement of ${bucket.label.toLowerCase()} posts?`,
        vary: `${bucket.label} versus your other posts`,
        arms: [
          { label: bucket.label, postsSoFar: bucket.n },
          { label: "Everything else", postsSoFar: Math.max(0, mix.total - bucket.n) },
        ],
        postsPerWeek,
        evidence: [
          fact(
            `${bucket.n} measured ${bucket.label.toLowerCase()} post(s) — ${needed} short of the ${MIN_N_FOR_MEDIAN} needed for a median.`,
            "post_metrics",
          ),
        ],
        confidence: "moderate",
        suggestedArchetype: null,
        suggestedHook: null,
        suggestedCta: null,
      }),
    );
  }

  return out.slice(0, 5);
}

function fromUntested(
  dimension: UntestedDimension,
  mix: ContentMix,
  postsPerWeek: number | null,
): ExperimentSuggestion {
  return build({
    id: `experiment-${dimension.dimension}-${dimension.value}`,
    title: `Try ${dimension.label.toLowerCase()}`,
    question: `What happens when a post uses ${dimension.label.toLowerCase()}?`,
    vary: dimension.label,
    arms: [
      { label: dimension.label, postsSoFar: 0 },
      { label: "Your current style", postsSoFar: mix.total },
    ],
    postsPerWeek,
    evidence: [
      fact(dimension.fact, "publish_history"),
      observation(
        "A dimension with no posts has no data either way — this is an untested option, not a weakness.",
        "content mix",
      ),
    ],
    confidence: "weak",
    suggestedArchetype: dimension.dimension === "archetype" ? (dimension.value as Archetype) : null,
    suggestedHook: dimension.dimension === "hook" ? (dimension.value as HookType) : null,
    suggestedCta: dimension.dimension === "cta" && dimension.value !== "any" ? (dimension.value as CtaType) : null,
  });
}

function build(spec: {
  id: string;
  title: string;
  question: string;
  vary: string;
  arms: Array<{ label: string; postsSoFar: number }>;
  postsPerWeek: number | null;
  evidence: EvidenceItem[];
  confidence: Confidence;
  suggestedArchetype: Archetype | null;
  suggestedHook: HookType | null;
  suggestedCta: CtaType | null;
}): ExperimentSuggestion {
  const remaining = spec.arms.reduce(
    (sum, arm) => sum + Math.max(0, MIN_N_FOR_MEDIAN - arm.postsSoFar),
    0,
  );
  const remainingForVerdict = spec.arms.reduce(
    (sum, arm) => sum + Math.max(0, MIN_N_FOR_VERDICT - arm.postsSoFar),
    0,
  );

  const weeksToDescriptive = weeksFor(remaining, spec.postsPerWeek);
  const weeksToVerdict = weeksFor(remainingForVerdict, spec.postsPerWeek);

  const status: ExperimentStatus =
    remaining === 0
      ? "ready"
      : weeksToDescriptive != null && weeksToDescriptive > UNREALISTIC_AFTER_WEEKS
        ? "not_realistic_at_this_rate"
        : weeksToVerdict != null && weeksToVerdict > UNREALISTIC_AFTER_WEEKS
          ? "descriptive_only_at_this_rate"
          : spec.arms.some((a) => a.postsSoFar > 0)
            ? "in_progress"
            : "descriptive_only_at_this_rate";

  return {
    id: spec.id,
    title: spec.title,
    question: spec.question,
    vary: spec.vary,
    holdConstant: [...HOLD_CONSTANT],
    arms: spec.arms,
    postsPerArmForMedian: MIN_N_FOR_MEDIAN,
    postsPerArmForVerdict: MIN_N_FOR_VERDICT,
    postsRemainingForDescriptive: remaining,
    weeksToDescriptive,
    weeksToVerdict,
    status,
    readout: readoutFor(status, remaining, weeksToDescriptive, weeksToVerdict),
    limitation:
      "Even when both arms fill, the result describes what was recorded. It does not " +
      "establish that the change caused the difference — the arms are not matched on " +
      "timing, audience, topic, or anything else that moves engagement.",
    evidence: spec.evidence,
    confidence: spec.confidence,
    suggestedArchetype: spec.suggestedArchetype,
    suggestedHook: spec.suggestedHook,
    suggestedCta: spec.suggestedCta,
    blocking: false,
  };
}

function weeksFor(postsNeeded: number, postsPerWeek: number | null): number | null {
  if (postsNeeded <= 0) return 0;
  if (postsPerWeek == null || postsPerWeek <= 0) return null;
  return Math.ceil(postsNeeded / postsPerWeek);
}

function readoutFor(
  status: ExperimentStatus,
  remaining: number,
  weeksToDescriptive: number | null,
  weeksToVerdict: number | null,
): string {
  const pace =
    weeksToDescriptive == null
      ? "Your publishing rate is not established yet, so there is no honest estimate of how long this would take."
      : `At your current rate that is roughly ${weeksToDescriptive} week(s).`;

  switch (status) {
    case "ready":
      return "Both arms already hold enough posts for a median, so this can be read now — descriptively.";
    case "not_realistic_at_this_rate":
      return `${remaining} more post(s) are needed. ${pace} That is long enough that this is probably not a question worth waiting on.`;
    case "descriptive_only_at_this_rate":
      return (
        `${remaining} more post(s) are needed for a description. ${pace} ` +
        (weeksToVerdict != null
          ? `A comparative verdict would need roughly ${weeksToVerdict} week(s), which is why the readout will stay descriptive.`
          : "A comparative verdict is not in reach, so the readout will stay descriptive.")
      );
    case "in_progress":
    default:
      return `${remaining} more post(s) are needed. ${pace} The readout will be descriptive.`;
  }
}

/** Operator-readable summary of the whole set. */
export function describeExperiments(
  suggestions: readonly ExperimentSuggestion[],
  postsPerWeek: number | null,
): string {
  if (suggestions.length === 0) {
    return "No experiment is worth suggesting yet — there is not enough published content to vary anything against.";
  }
  const ready = suggestions.filter((s) => s.status === "ready").length;
  const rate =
    postsPerWeek == null
      ? "Your publishing rate is not established, so the timings below are unavailable."
      : `At about ${roundTo(postsPerWeek, 1)} post(s) a week:`;
  return `${suggestions.length} experiment(s) available${ready > 0 ? `, ${ready} readable now` : ""}. ${rate}`;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
