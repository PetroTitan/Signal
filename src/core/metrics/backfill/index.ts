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

// Pricing moved to the budget module this milestone. Re-exported so
// callers have one import path for a backfill decision.
export {
  assessCost,
  describeResourcePlan,
  evaluateBudget,
  evaluateSpend,
  planResources,
  resolveBudgets,
  resolveXReadPrice,
  DEFAULT_DAILY_X_READ_BUDGET,
  PRICE_FRESHNESS_DAYS,
  type BudgetState,
  type CostAssessment,
  type ResolvedPrice,
  type SpendVerdict,
} from "../budget/x-read-budget";

export {
  executePlan,
  buildLiveBackfillDeps,
  type BackfillDeps,
  type BackfillRunResult,
  type BackfillPostOutcome,
  type BackfillPlatformProgress,
} from "./backfill-engine";
