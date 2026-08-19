/**
 * Provider cost model for the historical backfill.
 *
 * Why a whole module for this: the scheduled sweep reads a handful of
 * recent posts and its cost is noise. A backfill deliberately reaches
 * across the entire publication history, and on X every resource
 * returned is billable. An unbounded backfill is the one operation in
 * this subsystem that can spend real money, so the estimate is computed
 * BEFORE any request leaves the process and the operator has to affirm
 * it.
 *
 * Pure module — no I/O, no clock. Every rate is a documented constant
 * with the source that established it, so a stale rate is visible in
 * review rather than hidden in a comment.
 */

export interface ProviderRate {
  /** USD per billable resource. 0 means the provider does not charge. */
  usdPerResource: number;
  /** Where the rate came from — an official provider page, never a blog. */
  source: string;
  /** When a human last confirmed the rate against that source. */
  verifiedAt: string;
  /** Max ids/uris one request accepts, for batch planning. */
  batchSize: number;
  notes: string;
}

/**
 * X: reading YOUR OWN timeline qualifies for "Owned Reads" at $0.001 per
 * resource — an order of magnitude cheaper than the $0.005 generic Post
 * lookup. That is why the X backfill paginates
 * GET /2/users/{id}/tweets rather than fetching post ids individually:
 * it is both the cheaper rate AND a batch endpoint.
 *
 * Bluesky: no paid tier, no API key, no quota. getPosts accepts 25 uris.
 */
export const PROVIDER_RATES: Record<string, ProviderRate> = {
  x: {
    usdPerResource: 0.001,
    source: "https://docs.x.com/x-api/getting-started/pricing",
    verifiedAt: "2026-08-19",
    batchSize: 100,
    notes:
      "Owned Reads pricing for GET /2/users/{id}/tweets. Generic Post lookup " +
      "is $0.005/resource. Resources are deduplicated per 24h UTC day for " +
      "BILLING; the docs make no claim about value freshness, so we do not " +
      "assume a same-day re-read is free of charge in the estimate.",
  },
  bluesky: {
    usdPerResource: 0,
    source: "https://bsky.network/docs/rate-limits/",
    verifiedAt: "2026-08-19",
    batchSize: 25,
    notes:
      "Public AppView (public.api.bsky.app) is unauthenticated and free at " +
      "any volume. app.bsky.feed.getPosts accepts 25 uris per call.",
  },
  reddit: {
    usdPerResource: 0,
    source: "public permalink .json endpoint",
    verifiedAt: "2026-08-19",
    batchSize: 1,
    notes: "One request per post; no batch endpoint.",
  },
  devto: {
    usdPerResource: 0,
    source: "https://dev.to/api",
    verifiedAt: "2026-08-19",
    batchSize: 1,
    notes: "One request per article; no batch endpoint.",
  },
};

export function providerRate(platform: string): ProviderRate | null {
  return PROVIDER_RATES[platform] ?? null;
}

export interface PlatformCost {
  platform: string;
  posts: number;
  /** Requests we expect to issue, after batching. */
  requests: number;
  /** Billable resources — for X this is posts, not requests. */
  billableResources: number;
  usdPerResource: number;
  estimatedUsd: number;
  free: boolean;
  /** False when we have no documented rate for this platform. */
  rateKnown: boolean;
  source: string;
  verifiedAt: string;
}

export interface CostEstimate {
  perPlatform: PlatformCost[];
  totalEstimatedUsd: number;
  /** True when every platform in the plan has a documented rate. */
  fullyPriced: boolean;
  /** Platforms with no documented rate — these BLOCK a live run. */
  unpricedPlatforms: string[];
  /** True when any platform actually costs money. */
  requiresPaidRun: boolean;
}

/** Requests needed for n posts at a given batch size. */
export function batchCount(posts: number, batchSize: number): number {
  if (posts <= 0) return 0;
  return Math.ceil(posts / Math.max(1, batchSize));
}

/**
 * Cost of reading `postsByPlatform` once. Deliberately does NOT apply
 * X's 24-hour billing deduplication: the docs describe dedup as a
 * billing behaviour and say nothing about whether a repeat read returns
 * fresher values, so assuming the discount would be estimating in our
 * own favour on an unverified premise. The estimate is therefore an
 * upper bound, which is the correct direction for a spend gate.
 */
export function estimateBackfillCost(
  postsByPlatform: Record<string, number>,
): CostEstimate {
  const perPlatform: PlatformCost[] = [];
  const unpricedPlatforms: string[] = [];

  for (const platform of Object.keys(postsByPlatform).sort()) {
    const posts = postsByPlatform[platform] ?? 0;
    if (posts <= 0) continue;
    const rate = providerRate(platform);
    if (!rate) {
      unpricedPlatforms.push(platform);
      perPlatform.push({
        platform,
        posts,
        requests: posts,
        billableResources: posts,
        usdPerResource: Number.NaN,
        estimatedUsd: Number.NaN,
        free: false,
        rateKnown: false,
        source: "unknown",
        verifiedAt: "never",
      });
      continue;
    }
    const estimatedUsd = round4(posts * rate.usdPerResource);
    perPlatform.push({
      platform,
      posts,
      requests: batchCount(posts, rate.batchSize),
      billableResources: posts,
      usdPerResource: rate.usdPerResource,
      estimatedUsd,
      free: rate.usdPerResource === 0,
      rateKnown: true,
      source: rate.source,
      verifiedAt: rate.verifiedAt,
    });
  }

  const priced = perPlatform.filter((p) => p.rateKnown);
  const totalEstimatedUsd = round4(
    priced.reduce((sum, p) => sum + p.estimatedUsd, 0),
  );

  return {
    perPlatform,
    totalEstimatedUsd,
    fullyPriced: unpricedPlatforms.length === 0,
    unpricedPlatforms,
    requiresPaidRun: priced.some((p) => p.estimatedUsd > 0),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export type CostGateVerdict =
  | { allowed: true; reason: "free" | "confirmed" }
  | { allowed: false; reason: "unpriced_platform" | "confirmation_required" | "confirmation_too_low"; message: string };

/**
 * The spend gate. A run that costs nothing proceeds. A run that costs
 * money proceeds ONLY when the caller passed a confirmation ceiling at
 * least as large as the estimate — an explicit, auditable act rather
 * than a default.
 *
 * A platform with no documented rate blocks the run outright: the brief's
 * rule is that if cost cannot be verified at execution time we do not
 * execute, we hand the operator instructions.
 */
export function evaluateCostGate(
  estimate: CostEstimate,
  confirmedMaxUsd: number | null | undefined,
): CostGateVerdict {
  if (!estimate.fullyPriced) {
    return {
      allowed: false,
      reason: "unpriced_platform",
      message:
        `No documented cost rate for: ${estimate.unpricedPlatforms.join(", ")}. ` +
        "Cost cannot be verified at execution time, so the live backfill will " +
        "not run. Add a rate to PROVIDER_RATES with its official source, or " +
        "exclude the platform with the `platforms` parameter.",
    };
  }
  if (!estimate.requiresPaidRun) {
    return { allowed: true, reason: "free" };
  }
  if (confirmedMaxUsd == null) {
    return {
      allowed: false,
      reason: "confirmation_required",
      message:
        `This backfill is estimated to cost $${estimate.totalEstimatedUsd.toFixed(4)}. ` +
        "Re-run with `confirmedMaxUsd` set to at least that amount to authorise " +
        "the spend. Confirm first that the X developer project is on " +
        "pay-per-use with credits available at console.x.com.",
    };
  }
  if (confirmedMaxUsd < estimate.totalEstimatedUsd) {
    return {
      allowed: false,
      reason: "confirmation_too_low",
      message:
        `Estimated cost $${estimate.totalEstimatedUsd.toFixed(4)} exceeds the ` +
        `confirmed ceiling of $${Number(confirmedMaxUsd).toFixed(4)}. Lower ` +
        "`maxPosts` or raise `confirmedMaxUsd`.",
    };
  }
  return { allowed: true, reason: "confirmed" };
}

/** Operator-readable rendering of the estimate, used in refusals. */
export function describeCostEstimate(estimate: CostEstimate): string {
  if (estimate.perPlatform.length === 0) return "No posts in range; no cost.";
  const lines = estimate.perPlatform.map((p) =>
    p.rateKnown
      ? `${p.platform}: ${p.posts} post(s) in ${p.requests} request(s) — ` +
        (p.free
          ? "free"
          : `$${p.estimatedUsd.toFixed(4)} at $${p.usdPerResource}/resource ` +
            `(rate verified ${p.verifiedAt})`)
      : `${p.platform}: ${p.posts} post(s) — NO DOCUMENTED RATE`,
  );
  return `${lines.join("; ")}. Total: $${estimate.totalEstimatedUsd.toFixed(4)}.`;
}
