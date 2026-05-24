/**
 * publishing-qa — public surface.
 *
 * Re-exports the orchestrator and helpers callers should use. This
 * MVP is deliberately not wired into any platform adapter or
 * publishing flow yet: the layer is prepared, not enforced.
 *
 * When the integration PR lands, the draft generator and the
 * approval queue will call `qaDraft(...)` before persisting or
 * publishing a draft, and surface `result.findings` in the UI.
 */

export { qaDraft } from "./qa-draft";
export {
  classifyTopic,
  affinityFor,
  TOPIC_AFFINITY,
} from "./topic-matrix";
export { newAccountCaps } from "./new-account-mode";
export {
  derivativesFor,
  legalSourcesFor,
  DERIVATIVE_MAP,
} from "./derivative-map";
export {
  scanForNearDuplicates,
  jaccard,
  shingles,
  tokenize,
  canonicalize,
  NEAR_DUP_THRESHOLD,
  NEAR_DUP_WARN_THRESHOLD,
} from "./near-duplicate";
export {
  deterministicSimilarityProvider,
} from "./similarity-provider";
export type {
  QaInput,
  QaResult,
  QaVerdict,
  QaFinding,
  QaSeverity,
  QaCategory,
  QaDraft,
  QaIdentity,
  QaRecentPost,
  TopicKind,
  TopicAffinity,
  NewAccountCaps,
} from "./types";
export type { DuplicateMatch, DuplicateScanResult } from "./near-duplicate";
export type { DerivativeRule } from "./derivative-map";
export type { SimilarityProvider } from "./similarity-provider";
