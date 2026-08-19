/**
 * Social trust & performance intelligence.
 *
 * Deterministic first: every signal here is computed from text,
 * timestamps and provider counts, with no model in the path. AI may
 * interpret these outputs later; it does not produce them.
 */
export {
  MIN_N_FOR_MEDIAN,
  MIN_N_FOR_QUARTILES,
  MIN_N_FOR_VERDICT,
  MIN_MEANINGFUL_MEDIAN,
  STANDARD_CONFOUNDERS,
  FORBIDDEN_CAUSAL_PATTERNS,
  classifySample,
  classifyTrend,
  compareGroups,
  containsCausalClaim,
  describeComparison,
  median,
  quantile,
  summarizeSample,
  type SampleVerdict,
  type SampleSummary,
  type GroupComparison,
  type TrendResult,
  type TrendDirection,
} from "./statistics";

export {
  CROSS_PLATFORM_HIGH_THRESHOLD,
  CROSS_PLATFORM_WARN_THRESHOLD,
  MESSAGE_SHINGLE_K,
  VERBATIM_SHINGLE_K,
  VERBATIM_THRESHOLD,
  asPercent,
  bandCrossPlatform,
  isExactDuplicate,
  messageSimilarity,
  shingleSimilarity,
  verbatimSimilarity,
  type SimilarityBand,
} from "./similarity";

export {
  NEAR_SYNCHRONOUS_MINUTES,
  REPETITION_THRESHOLDS,
  analyzeRepetition,
  closingCta,
  openingHook,
  paragraphShape,
  rhythmSimilarity,
  type RepetitionFinding,
  type RepetitionKind,
  type RepetitionPost,
  type RepetitionReport,
  type RepetitionSeverity,
} from "./repetition";

export {
  BURST_MIN_POSTS,
  BURST_WINDOW_HOURS,
  DORMANT_AFTER_DAYS,
  INACTIVE_AFTER_DAYS,
  analyzeCadence,
  analyzeCadenceByPlatform,
  detectBursts,
  type CadencePost,
  type CadenceSignal,
  type CadenceState,
} from "./cadence";

export {
  reconcile,
  type KnownPublication,
  type ProviderPost,
  type ReconciledOrigin,
  type ReconciledPost,
  type ReconciliationReport,
} from "./reconciliation";

export {
  buildAccountHealthPanel,
  type AccountHealthPanel,
  type HealthInput,
  type HealthSignal,
  type SignalKey,
  type SignalState,
} from "./account-health";

export {
  NEVER_AUTOMATED,
  recommendNextActions,
  type Recommendation,
  type RecommendationKind,
  type RecommendationUrgency,
} from "./recommendations";
