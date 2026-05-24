/**
 * SimilarityProvider — an interface, not an implementation.
 *
 * The MVP scans for near-duplicates with deterministic shingles.
 * Embeddings are deliberately out of scope: they add an external
 * dependency, a vector store, and a latency budget that this layer
 * doesn't need yet.
 *
 * This file exists so the *signature* is stable. When we later swap
 * in an embedding-backed provider (Anthropic, Voyage, local
 * sentence-transformers, whatever), the orchestrator import stays
 * the same.
 */

import { jaccard, shingles, tokenize } from "./near-duplicate";

export interface SimilarityProvider {
  /**
   * Returns a score in [0, 1] where 1 is "the same text" and 0 is
   * "unrelated." Implementations are free to use any approach; the
   * orchestrator only knows about the score.
   */
  compare(a: string, b: string): Promise<number> | number;
  /** Stable identifier for logging. */
  readonly name: string;
}

/**
 * Default provider: Jaccard over 5-token shingles. Synchronous,
 * deterministic, zero-dependency. The orchestrator uses this unless
 * the caller passes a different provider.
 */
export const deterministicSimilarityProvider: SimilarityProvider = {
  name: "deterministic-shingle-jaccard",
  compare(a: string, b: string): number {
    return jaccard(shingles(tokenize(a)), shingles(tokenize(b)));
  },
};
