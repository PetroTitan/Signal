/**
 * X read budget and cost accounting (PURE).
 *
 * WHY THIS REPLACES A HARDCODED PRICE
 * -----------------------------------
 * The previous milestone baked $0.001/resource into a constant with a
 * "verified on" date. That was honest at the time and is the wrong shape
 * for product truth: a provider price is not code. It changes without a
 * deploy, it varies by account, and a stale constant is worse than no
 * constant because it looks authoritative.
 *
 * So price is now RESOLVED, in this order:
 *
 *   1. `X_READ_PRICE_USD_PER_RESOURCE` — operator-configured, authoritative
 *   2. the documented rate, but only while it is inside its freshness
 *      horizon; past that it is reported as STALE and treated as unknown
 *   3. unknown
 *
 * THE HARD INVARIANT
 * ------------------
 * Unknown price is NOT zero cost. A run whose cost cannot be bounded does
 * not proceed automatically — it reports the RESOURCE COUNT, which is
 * provider-independent truth Signal can always state, and asks the
 * operator to authorise. A test asserts an unknown price never yields a
 * $0.00 estimate or an automatic go-ahead.
 *
 * Pure module — the environment is read by the caller and passed in.
 */

/** Reads that cost nothing, whatever X charges. */
export const FREE_PLATFORMS = ["bluesky", "reddit", "devto"] as const;

/**
 * The rate published at docs.x.com/x-api/getting-started/pricing for
 * "Owned Reads" when this was last checked. Deliberately NOT treated as
 * permanent truth — see `PRICE_FRESHNESS_DAYS`.
 */
export const DOCUMENTED_X_OWNED_READ_USD = 0.001;
export const DOCUMENTED_X_RATE_VERIFIED_AT = "2026-08-19";
export const DOCUMENTED_X_RATE_SOURCE =
  "https://docs.x.com/x-api/getting-started/pricing";

/**
 * How long a documented price may be trusted without re-verification.
 * Past this the rate is reported as stale and treated as unknown, so a
 * silently-changed provider price cannot quietly become a wrong bill.
 */
export const PRICE_FRESHNESS_DAYS = 90;

/** Default ceilings. Both overridable by environment. */
export const DEFAULT_DAILY_X_READ_BUDGET = 500;
export const DEFAULT_BACKFILL_X_READ_BUDGET = 500;

export type PriceSource = "configured" | "documented" | "unknown";

export interface ResolvedPrice {
  /** NULL means unknown. It never means free. */
  usdPerResource: number | null;
  source: PriceSource;
  verifiedAt: string | null;
  /** True when a documented rate has aged out of its freshness horizon. */
  stale: boolean;
  explanation: string;
}

export interface PriceEnv {
  /** Raw `X_READ_PRICE_USD_PER_RESOURCE`, if set. */
  configuredRate?: string | null;
  /** Today, for the freshness check. */
  nowIso: string;
}

export function resolveXReadPrice(env: PriceEnv): ResolvedPrice {
  const configured = parseRate(env.configuredRate);
  if (configured != null) {
    return {
      usdPerResource: configured,
      source: "configured",
      verifiedAt: null,
      stale: false,
      explanation: `Using the operator-configured rate of $${configured} per resource (X_READ_PRICE_USD_PER_RESOURCE).`,
    };
  }

  // An explicitly empty or malformed setting is not a licence to guess.
  if (env.configuredRate != null && env.configuredRate.trim() !== "") {
    return {
      usdPerResource: null,
      source: "unknown",
      verifiedAt: null,
      stale: false,
      explanation:
        "X_READ_PRICE_USD_PER_RESOURCE is set but is not a valid non-negative number, so the price is unknown.",
    };
  }

  const ageDays = daysBetween(DOCUMENTED_X_RATE_VERIFIED_AT, env.nowIso);
  if (ageDays != null && ageDays > PRICE_FRESHNESS_DAYS) {
    return {
      usdPerResource: null,
      source: "unknown",
      verifiedAt: DOCUMENTED_X_RATE_VERIFIED_AT,
      stale: true,
      explanation:
        `The documented X rate was last verified on ${DOCUMENTED_X_RATE_VERIFIED_AT}, ` +
        `${Math.round(ageDays)} days ago, past the ${PRICE_FRESHNESS_DAYS}-day freshness horizon. ` +
        "Re-check it at " + DOCUMENTED_X_RATE_SOURCE + " and set " +
        "X_READ_PRICE_USD_PER_RESOURCE, or confirm the spend explicitly.",
    };
  }

  return {
    usdPerResource: DOCUMENTED_X_OWNED_READ_USD,
    source: "documented",
    verifiedAt: DOCUMENTED_X_RATE_VERIFIED_AT,
    stale: false,
    explanation:
      `Using the documented Owned Reads rate of $${DOCUMENTED_X_OWNED_READ_USD} per resource, ` +
      `verified ${DOCUMENTED_X_RATE_VERIFIED_AT} at ${DOCUMENTED_X_RATE_SOURCE}.`,
  };
}

export function isFreePlatform(platform: string): boolean {
  return (FREE_PLATFORMS as readonly string[]).includes(platform);
}

export interface ResourcePlan {
  /** Billable resources per platform. Always knowable, price or not. */
  byPlatform: Record<string, number>;
  xResources: number;
  freeResources: number;
  totalResources: number;
}

/**
 * Count what a plan will read. Resource counts are provider-independent
 * truth — Signal can always state them, even when it cannot price them,
 * and they are what an operator actually needs to authorise a spend.
 */
export function planResources(
  postsByPlatform: Record<string, number>,
): ResourcePlan {
  const byPlatform: Record<string, number> = {};
  let xResources = 0;
  let freeResources = 0;

  for (const platform of Object.keys(postsByPlatform).sort()) {
    const count = Math.max(0, postsByPlatform[platform] ?? 0);
    if (count === 0) continue;
    byPlatform[platform] = count;
    if (isFreePlatform(platform)) freeResources += count;
    else xResources += count;
  }

  return {
    byPlatform,
    xResources,
    freeResources,
    totalResources: xResources + freeResources,
  };
}

export interface CostAssessment {
  resources: ResourcePlan;
  price: ResolvedPrice;
  /** NULL when the price is unknown. NEVER 0 as a stand-in. */
  estimatedUsd: number | null;
  /** True only when every billable resource has a known price. */
  costKnown: boolean;
  /** True when the plan reads nothing billable at all. */
  entirelyFree: boolean;
  summary: string;
}

export function assessCost(
  postsByPlatform: Record<string, number>,
  env: PriceEnv,
): CostAssessment {
  const resources = planResources(postsByPlatform);
  const price = resolveXReadPrice(env);
  const entirelyFree = resources.xResources === 0;

  // A plan with nothing billable costs nothing regardless of price. This
  // is the ONLY path to a zero estimate.
  if (entirelyFree) {
    return {
      resources,
      price,
      estimatedUsd: 0,
      costKnown: true,
      entirelyFree: true,
      summary: `${resources.totalResources} resource(s), none billable. No cost.`,
    };
  }

  if (price.usdPerResource == null) {
    return {
      resources,
      price,
      estimatedUsd: null,
      costKnown: false,
      entirelyFree: false,
      summary:
        `${resources.xResources} billable X resource(s) — cost UNKNOWN. ${price.explanation}`,
    };
  }

  const estimatedUsd = round4(resources.xResources * price.usdPerResource);
  return {
    resources,
    price,
    estimatedUsd,
    costKnown: true,
    entirelyFree: false,
    summary:
      `${resources.xResources} billable X resource(s) at $${price.usdPerResource} each ` +
      `= $${estimatedUsd.toFixed(4)}. ${price.explanation}`,
  };
}

// ---------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------

export interface BudgetLimits {
  dailyXReads: number;
  backfillXReads: number;
}

export function resolveBudgets(env: {
  dailyXReads?: string | null;
  backfillXReads?: string | null;
}): BudgetLimits {
  return {
    dailyXReads: parseCount(env.dailyXReads) ?? DEFAULT_DAILY_X_READ_BUDGET,
    backfillXReads: parseCount(env.backfillXReads) ?? DEFAULT_BACKFILL_X_READ_BUDGET,
  };
}

export interface BudgetState {
  /** X resources already read in the current day, from run history. */
  spentToday: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

export function evaluateBudget(spentToday: number, limit: number): BudgetState {
  const remaining = Math.max(0, limit - Math.max(0, spentToday));
  return {
    spentToday: Math.max(0, spentToday),
    limit,
    remaining,
    exhausted: remaining <= 0,
  };
}

export type SpendVerdict =
  | { allowed: true; reason: "free" | "within_budget" | "confirmed" }
  | {
      allowed: false;
      reason: "cost_unknown" | "budget_exhausted" | "over_budget" | "confirmation_required" | "confirmation_too_low";
      message: string;
    };

/**
 * The spend gate.
 *
 * Ordered so the strictest condition wins. An unknown price blocks BEFORE
 * the budget check, because a budget in dollars cannot be applied to an
 * unpriced plan — and treating unknown as free is the specific bug this
 * whole module exists to prevent.
 */
export function evaluateSpend(input: {
  assessment: CostAssessment;
  budget: BudgetState;
  confirmedMaxUsd?: number | null;
  /** Set when the operator authorised by RESOURCE COUNT rather than dollars. */
  confirmedMaxResources?: number | null;
}): SpendVerdict {
  const { assessment, budget } = input;

  if (assessment.entirelyFree) return { allowed: true, reason: "free" };

  // Resource budget applies whether or not we can price it.
  if (budget.exhausted) {
    return {
      allowed: false,
      reason: "budget_exhausted",
      message: `The daily X read budget of ${budget.limit} resource(s) is already spent (${budget.spentToday} used). It resets at the next UTC day.`,
    };
  }
  if (assessment.resources.xResources > budget.remaining) {
    return {
      allowed: false,
      reason: "over_budget",
      message: `This would read ${assessment.resources.xResources} X resource(s) but only ${budget.remaining} remain in today's budget of ${budget.limit}. Lower the range, or raise SIGNAL_DAILY_X_READ_BUDGET.`,
    };
  }

  if (!assessment.costKnown) {
    // The invariant. An unknown price is not a free one.
    const byResource = input.confirmedMaxResources ?? null;
    if (byResource != null && byResource >= assessment.resources.xResources) {
      return { allowed: true, reason: "confirmed" };
    }
    return {
      allowed: false,
      reason: "cost_unknown",
      message:
        `Cost cannot be established, so this will not run automatically. ` +
        `${assessment.price.explanation} ` +
        `It would read ${assessment.resources.xResources} billable X resource(s). ` +
        `Either set X_READ_PRICE_USD_PER_RESOURCE, or authorise by resource count with ` +
        `confirmedMaxResources >= ${assessment.resources.xResources}.`,
    };
  }

  const estimated = assessment.estimatedUsd ?? 0;
  if (input.confirmedMaxUsd == null) {
    return {
      allowed: false,
      reason: "confirmation_required",
      message: `This is estimated to cost $${estimated.toFixed(4)}. Re-run with confirmedMaxUsd of at least that amount to authorise the spend.`,
    };
  }
  if (input.confirmedMaxUsd < estimated) {
    return {
      allowed: false,
      reason: "confirmation_too_low",
      message: `Estimated $${estimated.toFixed(4)} exceeds the confirmed ceiling of $${Number(input.confirmedMaxUsd).toFixed(4)}.`,
    };
  }
  return { allowed: true, reason: "confirmed" };
}

/** What Signal can always say, priced or not. */
export function describeResourcePlan(assessment: CostAssessment): string {
  const parts = Object.entries(assessment.resources.byPlatform)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, count]) =>
      isFreePlatform(platform)
        ? `${platform}: ${count} read(s), free`
        : `${platform}: ${count} billable resource(s)`,
    );
  const cost = assessment.costKnown
    ? assessment.estimatedUsd === 0
      ? "no cost"
      : `estimated $${(assessment.estimatedUsd ?? 0).toFixed(4)}`
    : "cost unknown";
  return `${parts.join("; ") || "nothing to read"}. Total ${assessment.resources.totalResources} resource(s), ${cost}.`;
}

function parseRate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseCount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function daysBetween(fromDate: string, toIso: string): number | null {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / 86_400_000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
