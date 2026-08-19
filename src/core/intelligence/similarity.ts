/**
 * Canonical text-similarity primitives for the intelligence layer (PURE).
 *
 * WHY THIS FILE EXISTS RATHER THAN A FOURTH IMPLEMENTATION
 * -------------------------------------------------------
 * Signal had THREE Jaccard implementations before this milestone:
 *
 *   publishing-qa/near-duplicate.ts          5-token shingles, URL-stripped,
 *                                            Unicode-aware, tested, wired
 *                                            into qaDraft
 *   platform-native/cross-platform-…ts       word unigrams, no URL strip,
 *                                            hook/CTA/rhythm findings
 *   operational-safety/cross-platform-drift  word unigrams, ASCII-only
 *                                            split, ZERO callers, and
 *                                            type-incapable of Bluesky
 *
 * They disagreed on tokenization, on thresholds, and even on whether two
 * empty sets are 0% or 100% similar. This module makes near-duplicate.ts
 * the single primitive and everything else a consumer of it. The drift
 * module is deleted; the platform-native detector keeps its distinct job
 * (hook / CTA / paragraph-rhythm reuse) and is called, not rewritten.
 *
 * SHINGLE SIZE IS THE LOAD-BEARING CHOICE, AND IT WAS MEASURED
 * -----------------------------------------------------------
 * Both metrics were computed over all 378 pairs of Signal's real
 * published X and Bluesky posts:
 *
 *                        5-token shingles      word bigrams
 *   cross-platform max        82.2%                83.0%
 *   pairs over 30%              1                    3
 *   pairs over 12%              1                    7
 *   within-X max                2.0%                 7.8%
 *   within-Bluesky max          0.0%                 4.3%
 *
 * 5-token shingles find only near-VERBATIM reuse: they caught the one
 * copy-paste pair and missed every rephrasing. The pairs at 45.7%, 36.4%
 * and 26.5% bigram similarity — the same message reworded for the other
 * platform, published minutes apart — are invisible to them.
 *
 * So the two sizes measure different things and both are kept:
 *   k=5  "this is the same text"
 *   k=2  "this is the same message, reworded"
 *
 * Pure module — no I/O.
 */

import {
  canonicalize,
  jaccard,
  shingles,
  tokenize,
} from "@/core/publishing-qa/near-duplicate";

export { canonicalize, jaccard, shingles, tokenize };

/** Verbatim / near-verbatim reuse. Matches the existing QA metric. */
export const VERBATIM_SHINGLE_K = 5;

/** Same-message reuse that survives rewording. */
export const MESSAGE_SHINGLE_K = 2;

/**
 * Cross-platform WARN threshold on word bigrams.
 *
 * Calibrated, not guessed: the highest within-platform bigram similarity
 * in the real corpus is 7.8%, and the lowest cross-platform pair worth
 * flagging is 13.7%. 0.12 sits in that gap with margin on both sides —
 * it flags all seven genuine cross-platform pairs and zero
 * within-platform pairs.
 */
export const CROSS_PLATFORM_WARN_THRESHOLD = 0.12;

/**
 * Cross-platform HIGH threshold. Above this the posts are recognisably
 * the same message; the real corpus has three such pairs (83.0%, 45.7%,
 * 36.4%), each published within five minutes of its counterpart.
 */
export const CROSS_PLATFORM_HIGH_THRESHOLD = 0.3;

/** Verbatim threshold, shared with the existing near-duplicate QA gate. */
export const VERBATIM_THRESHOLD = 0.45;

/**
 * Jaccard over k-token shingles of two texts.
 *
 * EMPTY-INPUT GUARD. `tokenize("")` yields `[]`, and `shingles([], k)`
 * collapses that to `Set([""])` — so two empty strings produced a
 * Jaccard of 1.0 and two posts with null bodies on different platforms
 * were reported as a 100%-similar cross-platform copy at severity
 * "high". Empty text is not similar to anything, including other empty
 * text, so it scores 0.
 */
export function shingleSimilarity(a: string, b: string, k: number): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  // `shingles` collapses inputs shorter than k into a single whole-text
  // shingle, so two short posts still compare sensibly.
  return jaccard(shingles(ta, k), shingles(tb, k));
}

/** "Is this the same text?" */
export function verbatimSimilarity(a: string, b: string): number {
  return shingleSimilarity(a, b, VERBATIM_SHINGLE_K);
}

/** "Is this the same message, reworded?" */
export function messageSimilarity(a: string, b: string): number {
  return shingleSimilarity(a, b, MESSAGE_SHINGLE_K);
}

/** Exact-match fingerprint of the canonical text, ignoring URLs and case. */
export function isExactDuplicate(a: string, b: string): boolean {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  return ca.length > 0 && ca === cb;
}

export type SimilarityBand = "none" | "warn" | "high" | "verbatim";

/**
 * Band a cross-platform pair. Ordered most-severe first so the label
 * reflects the strongest evidence, not the first threshold crossed.
 */
export function bandCrossPlatform(input: {
  verbatim: number;
  message: number;
  exact: boolean;
}): SimilarityBand {
  if (input.exact || input.verbatim >= VERBATIM_THRESHOLD) return "verbatim";
  if (input.message >= CROSS_PLATFORM_HIGH_THRESHOLD) return "high";
  if (input.message >= CROSS_PLATFORM_WARN_THRESHOLD) return "warn";
  return "none";
}

/** Percentage, rounded for display. */
export function asPercent(similarity: number): number {
  return Math.round(similarity * 1000) / 10;
}
