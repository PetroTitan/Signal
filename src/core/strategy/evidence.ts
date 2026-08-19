/**
 * The evidence taxonomy (PURE).
 *
 * Every output of this layer carries exactly one category, and they are
 * never interchangeable:
 *
 *   FACT           read directly from a record
 *   OBSERVATION    deterministically derived from facts
 *   SUGGESTION     advisory interpretation of observations
 *   EXPERIMENT     a suggestion whose purpose is to produce evidence
 *   AI             optional synthesis over the four above
 *
 * Collapsing them is how an advisory system turns into a confident one.
 * A suggestion presented as a fact is a lie; a fact presented as a
 * suggestion is useless. The type system keeps them apart, and an
 * invariant test asserts nothing downstream merges them.
 *
 * Pure module — no I/O, no clock.
 */

export type EvidenceCategory =
  | "fact"
  | "observation"
  | "suggestion"
  | "experiment"
  | "ai_interpretation";

/**
 * How much weight a derived value can bear.
 *
 * `none` always accompanies an unknown value. The system does not round
 * weak up to moderate: a classification made from one keyword says so.
 */
export type Confidence = "strong" | "moderate" | "weak" | "none";

export interface EvidenceItem {
  category: EvidenceCategory;
  /** One sentence, with the numbers in it. */
  statement: string;
  /** Where it came from — a table, a computation, or a provider. */
  source: string;
  /** The window it covers, when it has one. */
  timeframe?: string;
}

export function fact(statement: string, source: string, timeframe?: string): EvidenceItem {
  return { category: "fact", statement, source, timeframe };
}

export function observation(
  statement: string,
  source: string,
  timeframe?: string,
): EvidenceItem {
  return { category: "observation", statement, source, timeframe };
}

/**
 * A classified value with the evidence that produced it.
 *
 * This is the shape every classifier in this layer returns. A bare label
 * is not acceptable output: the operator has to be able to disagree, and
 * they cannot disagree with a word.
 */
export interface Classified<T> {
  value: T;
  confidence: Confidence;
  /** Why this value. Empty only when confidence is "none". */
  evidence: string[];
}

export function classified<T>(
  value: T,
  confidence: Confidence,
  evidence: string[],
): Classified<T> {
  return { value, confidence, evidence };
}

/** An unknown classification. Always confidence "none". */
export function unknownClassification<T>(
  unknownValue: T,
  reason = "No distinguishing signal found.",
): Classified<T> {
  return { value: unknownValue, confidence: "none", evidence: [reason] };
}

/**
 * Confidence from a count of independent supporting signals.
 *
 * Deliberately conservative: one signal is weak, two is moderate, three
 * or more is strong. Nothing reaches strong on a single keyword.
 */
export function confidenceFromSignals(signalCount: number): Confidence {
  if (signalCount <= 0) return "none";
  if (signalCount === 1) return "weak";
  if (signalCount === 2) return "moderate";
  return "strong";
}

export function isConfidentEnoughToReport(confidence: Confidence): boolean {
  return confidence !== "none";
}

/** Ordering for display: the most reliable first. */
export function confidenceRank(confidence: Confidence): number {
  switch (confidence) {
    case "strong":
      return 0;
    case "moderate":
      return 1;
    case "weak":
      return 2;
    default:
      return 3;
  }
}

/**
 * Strategy-specific causal overclaims, on top of the generic set in
 * `@/core/intelligence/statistics`.
 *
 * These are the sentences a content-advice product is most tempted to
 * write, and every one of them asserts a causal mechanism no provider
 * exposes.
 */
export const FORBIDDEN_STRATEGY_PATTERNS: RegExp[] = [
  /\bincreases?\s+(your\s+)?(reach|engagement|impressions|views)\b/i,
  /\bboosts?\s+(your\s+)?(reach|engagement|impressions|views)\b/i,
  /\bthe algorithm (prefers|favou?rs|rewards|likes|punishes)\b/i,
  /\bposting at \d/i,
  /\bbest time to post\b/i,
  /\bwill (get|receive|drive) more\b/i,
  /\bguaranteed?\s+(to|more)\b/i,
  /\bby \d+%\b/i,
  /\bproven to\b/i,
  /\balways perform/i,
];

/** True when the text asserts a causal or predictive performance claim. */
export function containsStrategyOverclaim(text: string): boolean {
  return FORBIDDEN_STRATEGY_PATTERNS.some((p) => p.test(text));
}

/**
 * Wording that keeps a comparison honest when the sample is small.
 * Exported so the same phrasing is used everywhere rather than
 * re-invented per call site.
 */
export const SMALL_SAMPLE_CAVEAT =
  "The sample is small, so this is a description of what happened rather than a finding.";

export const NO_PERFORMANCE_DATA_CAVEAT =
  "No performance data has been collected yet, so this is based on what you have published rather than on how it performed.";
