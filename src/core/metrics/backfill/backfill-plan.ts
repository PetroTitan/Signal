/**
 * Bounded historical backfill — planning.
 *
 * The scheduled sweep enrols publications from the last
 * DEFAULT_SEED_WINDOW_DAYS only, and that default is correct: a daily
 * cron only needs to notice recent posts. The consequence is that
 * anything published before the window was never measured and never
 * will be by the sweep. Widening the sweep's window to compensate would
 * make every nightly run re-scan the entire history forever.
 *
 * So the backfill is a separate, deliberately-invoked operation with
 * hard bounds. This module is the PURE half: it turns "what does the
 * operator want backfilled" into an explicit, reviewable plan with a
 * cost estimate and a spend verdict, before anything touches a provider.
 *
 * Pure module — no I/O, no clock, no randomness.
 */

import {
  describeCostEstimate,
  estimateBackfillCost,
  evaluateCostGate,
  providerRate,
  type CostEstimate,
  type CostGateVerdict,
} from "./backfill-cost";

/** Hard ceiling regardless of what the caller asks for. A backfill is a
 *  repair operation, not a crawler. */
export const MAX_BACKFILL_POSTS = 500;

export interface BackfillCandidate {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  externalPostId: string | null;
  permalink: string | null;
  /** publish_history.finished_at — when Signal's request completed. */
  publishedAt: string;
  /** True when a canonical metrics row already exists. */
  alreadyMeasured: boolean;
}

export interface BackfillBounds {
  /** Inclusive ISO lower bound on publication time. Required — a
   *  backfill without a floor is not bounded. */
  since: string;
  /** Exclusive ISO upper bound. Defaults to the caller's "now". */
  until: string;
  /** Hard cap on posts considered, after filtering. */
  maxPosts: number;
  /** Restrict to these platforms; empty means every verified platform. */
  platforms: string[];
  /** Re-read posts that already have a canonical row. Off by default:
   *  the point is to reach the ones the sweep could never enrol. */
  includeAlreadyMeasured: boolean;
}

export interface BackfillBatch {
  platform: string;
  /** Candidates in this request. Size respects the provider's batch limit. */
  candidates: BackfillCandidate[];
}

export type BackfillRejection =
  | "outside_date_range"
  | "platform_excluded"
  | "already_measured"
  | "no_provider_identifier"
  | "over_max_posts";

export interface BackfillPlan {
  bounds: BackfillBounds;
  /** Candidates that will actually be read, in deterministic order. */
  selected: BackfillCandidate[];
  /** Why each excluded candidate was dropped — so a surprising plan is
   *  self-explaining rather than requiring a re-run to investigate. */
  rejected: Array<{ candidate: BackfillCandidate; reason: BackfillRejection }>;
  batches: BackfillBatch[];
  postsByPlatform: Record<string, number>;
  cost: CostEstimate;
  costSummary: string;
  gate: CostGateVerdict;
  /** True when the plan may execute against live providers. */
  executable: boolean;
}

export interface PlanInput {
  candidates: BackfillCandidate[];
  bounds: Partial<BackfillBounds> & { since: string; until: string };
  confirmedMaxUsd?: number | null;
}

/**
 * Build the plan. Selection order is (publishedAt DESC, publishHistoryId)
 * so that when `maxPosts` truncates, the operator gets the MOST RECENT
 * posts — those are the ones whose provider-side data is most likely to
 * still be complete, and on X the only ones whose 30-day private metrics
 * could survive at all.
 */
export function planBackfill(input: PlanInput): BackfillPlan {
  const bounds: BackfillBounds = {
    since: input.bounds.since,
    until: input.bounds.until,
    maxPosts: clamp(input.bounds.maxPosts ?? MAX_BACKFILL_POSTS, 1, MAX_BACKFILL_POSTS),
    platforms: [...(input.bounds.platforms ?? [])].sort(),
    includeAlreadyMeasured: input.bounds.includeAlreadyMeasured ?? false,
  };

  const rejected: BackfillPlan["rejected"] = [];
  const eligible: BackfillCandidate[] = [];

  const ordered = [...input.candidates].sort(
    (a, b) =>
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.publishHistoryId.localeCompare(b.publishHistoryId),
  );

  for (const c of ordered) {
    if (bounds.platforms.length > 0 && !bounds.platforms.includes(c.platform)) {
      rejected.push({ candidate: c, reason: "platform_excluded" });
      continue;
    }
    if (c.publishedAt < bounds.since || c.publishedAt >= bounds.until) {
      rejected.push({ candidate: c, reason: "outside_date_range" });
      continue;
    }
    if (c.alreadyMeasured && !bounds.includeAlreadyMeasured) {
      rejected.push({ candidate: c, reason: "already_measured" });
      continue;
    }
    if (!c.externalPostId && !c.permalink) {
      // Cannot be read at any price — do not let it consume budget.
      rejected.push({ candidate: c, reason: "no_provider_identifier" });
      continue;
    }
    eligible.push(c);
  }

  const selected = eligible.slice(0, bounds.maxPosts);
  for (const c of eligible.slice(bounds.maxPosts)) {
    rejected.push({ candidate: c, reason: "over_max_posts" });
  }

  const postsByPlatform: Record<string, number> = {};
  for (const c of selected) {
    postsByPlatform[c.platform] = (postsByPlatform[c.platform] ?? 0) + 1;
  }

  const cost = estimateBackfillCost(postsByPlatform);
  const gate = evaluateCostGate(cost, input.confirmedMaxUsd);

  return {
    bounds,
    selected,
    rejected,
    batches: buildBatches(selected),
    postsByPlatform,
    cost,
    costSummary: describeCostEstimate(cost),
    gate,
    executable: gate.allowed && selected.length > 0,
  };
}

/**
 * Group by platform and split at the provider's documented batch limit,
 * so a 15-post Bluesky backfill is one request rather than fifteen.
 * Deterministic: platforms sorted, candidates already ordered.
 */
export function buildBatches(selected: BackfillCandidate[]): BackfillBatch[] {
  const byPlatform = new Map<string, BackfillCandidate[]>();
  for (const c of selected) {
    const list = byPlatform.get(c.platform) ?? [];
    list.push(c);
    byPlatform.set(c.platform, list);
  }
  const batches: BackfillBatch[] = [];
  for (const platform of Array.from(byPlatform.keys()).sort()) {
    const list = byPlatform.get(platform) ?? [];
    const size = Math.max(1, providerRate(platform)?.batchSize ?? 1);
    for (let i = 0; i < list.length; i += size) {
      batches.push({ platform, candidates: list.slice(i, i + size) });
    }
  }
  return batches;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return max;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Summary of why a plan will not execute, for the API response. */
export function describePlan(plan: BackfillPlan): string {
  if (plan.selected.length === 0) {
    const reasons = new Map<BackfillRejection, number>();
    for (const r of plan.rejected) {
      reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    }
    const detail = Array.from(reasons.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, n]) => `${reason} x${n}`)
      .join(", ");
    return `Nothing to backfill in ${plan.bounds.since}..${plan.bounds.until}${
      detail ? ` (excluded: ${detail})` : ""
    }.`;
  }
  if (!plan.gate.allowed) {
    return `Plan blocked: ${plan.gate.message}`;
  }
  return `${plan.selected.length} post(s) in ${plan.batches.length} request(s). ${plan.costSummary}`;
}
