/**
 * Bounded historical metrics backfill.
 *
 * Separate from the nightly sweep on purpose: the sweep's rolling
 * enrolment window is correct for a cron and is precisely why older
 * publications were never measured. Recovery is an explicit, bounded,
 * cost-gated operation.
 */
export {
  planBackfill,
  buildBatches,
  describePlan,
  MAX_BACKFILL_POSTS,
  type BackfillPlan,
  type BackfillBounds,
  type BackfillCandidate,
  type BackfillBatch,
  type BackfillRejection,
  type PlanInput,
} from "./backfill-plan";

export {
  PROVIDER_RATES,
  providerRate,
  batchCount,
  estimateBackfillCost,
  evaluateCostGate,
  describeCostEstimate,
  type ProviderRate,
  type PlatformCost,
  type CostEstimate,
  type CostGateVerdict,
} from "./backfill-cost";

export {
  executePlan,
  buildLiveBackfillDeps,
  type BackfillDeps,
  type BackfillRunResult,
  type BackfillPostOutcome,
  type BackfillPlatformProgress,
} from "./backfill-engine";
