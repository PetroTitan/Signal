/**
 * Deterministic near-duplicate detection.
 *
 * No embeddings, no external services. Two complementary signals:
 *
 *   1. Hook similarity — normalized exact + prefix overlap.
 *   2. Body similarity — Jaccard over 5-token shingles, after
 *      canonicalization (lowercase, URL-stripped, punctuation
 *      collapsed). Threshold 0.45 ≈ "this is a re-skinned version of
 *      a post we already shipped" without flagging two posts that
 *      happen to share a single sentence.
 *
 * Pure functions. The caller passes recent posts in; we don't read
 * the DB.
 */

import type { QaRecentPost } from "./types";

const URL_RE = /\bhttps?:\/\/\S+/gi;
const SHINGLE_K = 5;
/**
 * Tuned by hand on the WebmasterID corpus. 0.45 caught the obvious
 * "I just rephrased my X post for Bluesky" cases without false-
 * positives on two posts that legitimately share a paragraph of
 * domain terminology.
 */
export const NEAR_DUP_THRESHOLD = 0.45;
/**
 * A separate (looser) bar for the "soft warn" tier. Posts above this
 * but below the block threshold get a warning instead.
 */
export const NEAR_DUP_WARN_THRESHOLD = 0.3;

export function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return canonicalize(text).split(" ").filter((t) => t.length > 0);
}

export function shingles(tokens: ReadonlyArray<string>, k = SHINGLE_K): Set<string> {
  if (tokens.length < k) {
    // Short inputs: treat the whole canonicalized text as one shingle
    // so two identical short bodies still match.
    return new Set([tokens.join(" ")]);
  }
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - k; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function hookSimilarity(a: string, b: string): number {
  const aN = canonicalize(a);
  const bN = canonicalize(b);
  if (!aN || !bN) return 0;
  if (aN === bN) return 1;
  const shorter = aN.length < bN.length ? aN : bN;
  const longer = aN.length < bN.length ? bN : aN;
  // Strong prefix overlap is the most common dup pattern in
  // platform-native rephrasings.
  let prefix = 0;
  while (prefix < shorter.length && shorter[prefix] === longer[prefix]) {
    prefix++;
  }
  return prefix / longer.length;
}

export interface DuplicateMatch {
  post: QaRecentPost;
  bodySimilarity: number;
  hookSimilarity: number;
  /** Worst of the two — the score the orchestrator gates on. */
  score: number;
}

export interface DuplicateScanResult {
  /**
   * Highest-scoring match against any recent post. Null when nothing
   * cleared the soft warn threshold.
   */
  bestMatch: DuplicateMatch | null;
  /** Posts above the block threshold. */
  blocking: ReadonlyArray<DuplicateMatch>;
}

export function scanForNearDuplicates(input: {
  hook: string;
  body: string;
  recentHistory: ReadonlyArray<QaRecentPost>;
}): DuplicateScanResult {
  const draftShingles = shingles(tokenize(input.body));
  const matches: DuplicateMatch[] = [];
  for (const post of input.recentHistory) {
    const bodyShingles = shingles(tokenize(post.body));
    const bodySim = jaccard(draftShingles, bodyShingles);
    const hookSim = hookSimilarity(input.hook, post.hook);
    const score = Math.max(bodySim, hookSim);
    if (score >= NEAR_DUP_WARN_THRESHOLD) {
      matches.push({ post, bodySimilarity: bodySim, hookSimilarity: hookSim, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const blocking = matches.filter((m) => m.score >= NEAR_DUP_THRESHOLD);
  return { bestMatch: matches[0] ?? null, blocking };
}
