import "server-only";
/**
 * One cron delivery, shared fairly between every due campaign.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The endpoint ran the follow dispatcher with the whole budget, then
 * the unfollow dispatcher with the remainder; within a kind, each
 * campaign ran chunk after chunk until its quota or the budget was
 * spent. On a runtime that fits one or two chunks per delivery that is
 * a monopoly: the earliest-due follow campaign is served every five
 * minutes, and a second follow campaign or any unfollow campaign can
 * wait all day. Production processed one 20-member chunk in one
 * delivery; nothing in the code guaranteed the NEXT delivery would go
 * to anyone else.
 *
 * THE SHAPE NOW
 * -------------
 * Rounds. Each round lists every due campaign of BOTH kinds, orders
 * them by when they were last served (`last_dispatched_at`, persisted,
 * nulls first — never served goes first), and gives each AT MOST ONE
 * chunk. Another round runs only if safe time remains. Across
 * deliveries the persisted order means a campaign served in this
 * delivery is behind the others in the next, so the rotation survives
 * the process not surviving.
 *
 * QUOTA PRIORITY IS NOT SCHEDULING PRIORITY
 * -----------------------------------------
 * The product decision stands: when the identity's shared daily
 * budget is genuinely running out, the work that does not happen is
 * the irreversible deletion, not the creation. That is enforced at the
 * moment an unfollow campaign would CLAIM, by comparing what the
 * identity has left today with what the due follow campaigns on that
 * identity still need today. It is not enforced by running follow
 * first — which is what starved unfollow when the budget was fine and
 * the runtime was the constraint.
 *
 * THE DEADLINE
 * ------------
 * Conservative by default. The route declares `maxDuration = 300`, but
 * a platform may clamp that (Vercel Hobby: 60 s), and the plan this
 * project deploys under could not be verified from here. So the
 * default assumes a 60-second ceiling and stops CLAIMING new work once
 * fewer than one chunk's worth of time remains — never mid-chunk, so a
 * claimed chunk is always settled or released by its own code, not by
 * the platform's kill. `BLUESKY_TICK_BUDGET_MS` raises it on a runtime
 * known to allow more. See docs/relationships/campaigns-runbook.md.
 *
 * Throughput follows from this: 300/day means 300 spread over the
 * day's deliveries, never 300 in one request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BlueskyFollowCampaignRow } from "@/lib/supabase/types";
import {
  countMembersByStatus,
  getIdentityUsage,
  getRunForLocalDate,
  listDueCampaigns,
  recoverReauthorizedCampaignsForConnectedIdentities,
  touchCampaignDispatched,
} from "@/repositories/bluesky-campaign-repository";
import { INTER_REQUEST_MS } from "@/core/bluesky-relationships/execute-actions.server";
import { IDENTITY_DAILY_FOLLOW_CEILING } from "./quota";
import { CAMPAIGN_CHUNK_SIZE } from "./worker.server";
import { IDENTITY_DAILY_MUTATION_CEILING } from "@/core/bluesky-unfollow/quota";
import { localClockAt } from "./campaign-day";
import { dispatchCampaigns, type DispatchResult } from "./dispatcher.server";
import {
  dispatchUnfollowCampaigns,
  type UnfollowDispatchResult,
} from "@/core/bluesky-unfollow/dispatcher.server";

/** Assumed platform ceiling when nothing says otherwise. */
export const DEFAULT_TICK_DEADLINE_MS = 55_000;
/** Never claim past this even if the environment asks for more. */
export const MAX_TICK_DEADLINE_MS = 240_000;
/**
 * Provider latency allowed per member on top of the 1,000 ms spacing
 * floor. A chunk of 20 is therefore budgeted at 30 s.
 */
export const PROVIDER_LATENCY_ALLOWANCE_MS = 500;
/** What one chunk is expected to cost, end to end. */
export const CHUNK_COST_MS =
  CAMPAIGN_CHUNK_SIZE * (INTER_REQUEST_MS + PROVIDER_LATENCY_ALLOWANCE_MS);
/** Time reserved after the last chunk to settle, release and respond. */
export const SETTLE_MARGIN_MS = 5_000;

/**
 * The deadline for this deployment.
 *
 * `BLUESKY_TICK_BUDGET_MS` is honoured between 10 s and
 * `MAX_TICK_DEADLINE_MS`; anything else falls back to the conservative
 * default. Pure, so the choice is testable.
 */
export function tickDeadlineMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.BLUESKY_TICK_BUDGET_MS);
  if (!Number.isFinite(raw) || raw < 10_000) return DEFAULT_TICK_DEADLINE_MS;
  return Math.min(Math.floor(raw), MAX_TICK_DEADLINE_MS);
}

export interface FairDispatchInput {
  db?: SupabaseClient;
  nowIso?: string;
  /** Total wall-clock budget for this delivery. */
  deadlineMs?: number;
  /** Override the per-chunk cost estimate (tests drive a fake clock). */
  chunkCostMs?: number;
  settleMarginMs?: number;
  /** Cap on rounds, mainly for tests. */
  maxRounds?: number;
  /** Restrict to one workspace or campaign (manual "run now"). */
  workspaceId?: string;
  campaignId?: string;
  appView?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
  monotonicNowMs?: () => number;
  currentTime?: () => Date;
}

export interface FairDispatchResult {
  deadlineMs: number;
  rounds: number;
  /** Campaign ids in the order they were served, one entry per chunk. */
  served: { campaignId: string; kind: "follow" | "unfollow"; round: number }[];
  /** Campaigns that were due but yielded or were not reached. */
  deferred: { campaignId: string; kind: "follow" | "unfollow"; reason: string }[];
  follow: DispatchResult;
  unfollow: UnfollowDispatchResult;
  notes: string[];
}

type Kind = "follow" | "unfollow";
type Due = BlueskyFollowCampaignRow & { kind: Kind };

/**
 * Round order: least recently served first (never served first of
 * all), follow before unfollow among equals, then the scheduler's own
 * due order, then id so the order is total and reproducible.
 *
 * Exported so the ordering itself is testable — and so a mutation that
 * removes it fails a test rather than a production day.
 */
export function orderForFairness<T extends Due>(campaigns: T[]): T[] {
  // Never served sorts before any stamp. Compared with `<`, not by
  // subtraction: two sentinels subtracted give NaN, and a comparator
  // that returns NaN makes the order depend on the engine.
  const stamp = (c: T): number | null => {
    const raw = c.last_dispatched_at ?? null;
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  };
  const due = (c: T): number | null => {
    if (!c.next_run_at) return null;
    const t = Date.parse(c.next_run_at);
    return Number.isNaN(t) ? null : t;
  };
  const cmp = (x: number | null, y: number | null): number => {
    if (x === y) return 0;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
  };
  return [...campaigns].sort((a, b) => {
    const s = cmp(stamp(a), stamp(b));
    if (s !== 0) return s;
    if (a.kind !== b.kind) return a.kind === "follow" ? -1 : 1;
    const d = cmp(due(a), due(b));
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

async function listDueRound(input: FairDispatchInput, nowIso: string): Promise<Due[]> {
  // Campaigns whose identity has been signed in again come back BEFORE
  // the round is listed — one bounded statement in the database, no
  // provider probe. A campaign still waiting for its identity is not
  // listed at all: it costs the round nothing and is never mistaken
  // for one that was served.
  await recoverReauthorizedCampaignsForConnectedIdentities({
    workspaceId: input.workspaceId ?? null,
    campaignId: input.campaignId ?? null,
    nowIso,
    db: input.db,
  });
  const [follow, unfollow] = await Promise.all([
    listDueCampaigns({
      nowIso,
      kind: "follow",
      statuses: ["active"],
      limit: 25,
      db: input.db,
    }),
    listDueCampaigns({
      nowIso,
      kind: "unfollow",
      statuses: ["active", "rate_limited"],
      limit: 25,
      db: input.db,
    }),
  ]);
  let due: Due[] = [
    ...follow.map((c) => ({ ...c, kind: "follow" as const })),
    ...unfollow.map((c) => ({ ...c, kind: "unfollow" as const })),
  ];
  if (input.workspaceId) due = due.filter((c) => c.workspace_id === input.workspaceId);
  if (input.campaignId) due = due.filter((c) => c.id === input.campaignId);
  return orderForFairness(due);
}

/**
 * Should this unfollow campaign stand aside for follow work on the
 * same identity RIGHT NOW?
 *
 * Yes when what the identity has left today is no more than what the
 * due follow campaigns on it still need today. Computed from the
 * existing counters — identity usage, each follow campaign's run and
 * remaining queue — so there is no second quota model to drift from
 * the first. Fails OPEN on a read error: a scheduling hint must not
 * stop a campaign the reservation RPC would otherwise fund.
 */
async function followHasPriority(
  candidate: Due,
  round: Due[],
  now: Date,
  db: SupabaseClient | undefined,
): Promise<{ yield: boolean; reason: string | null }> {
  const followPeers = round.filter(
    (c) =>
      c.kind === "follow" &&
      c.workspace_id === candidate.workspace_id &&
      c.operator_account_id === candidate.operator_account_id &&
      c.status === "active",
  );
  if (followPeers.length === 0) return { yield: false, reason: null };
  try {
    const usage = await getIdentityUsage({
      workspaceId: candidate.workspace_id,
      operatorAccountId: candidate.operator_account_id,
      usageDate: now.toISOString().slice(0, 10),
      db,
    });
    const identityRemaining =
      IDENTITY_DAILY_MUTATION_CEILING - Number(usage?.attempts_made ?? 0);

    let followNeed = 0;
    for (const peer of followPeers) {
      const [counts, run] = await Promise.all([
        countMembersByStatus({
          workspaceId: peer.workspace_id,
          campaignId: peer.id,
          db,
        }),
        getRunForLocalDate({
          workspaceId: peer.workspace_id,
          campaignId: peer.id,
          localDate: localClockAt(now, peer.timezone).localDate,
          db,
        }),
      ]);
      const cap = Math.min(peer.requested_daily_quota, IDENTITY_DAILY_FOLLOW_CEILING);
      const attemptedToday = Number(run?.attempted_count ?? 0);
      followNeed += Math.max(0, Math.min(cap - attemptedToday, counts.remainingEligible));
    }
    if (followNeed > 0 && identityRemaining <= followNeed) {
      return {
        yield: true,
        reason: `follow campaigns on this identity still need ${followNeed} of its remaining ${Math.max(0, identityRemaining)} actions today; unfollow waits`,
      };
    }
    return { yield: false, reason: null };
  } catch {
    return { yield: false, reason: null };
  }
}

const emptyFollow = (): DispatchResult => ({
  campaignsConsidered: 0,
  campaignsRun: 0,
  chunksProcessed: 0,
  attempted: 0,
  succeeded: 0,
  alreadyFollowing: 0,
  skipped: 0,
  failed: 0,
  notes: [],
});

function mergeFollow(into: DispatchResult, r: DispatchResult) {
  into.campaignsConsidered += r.campaignsConsidered;
  into.campaignsRun += r.campaignsRun;
  into.chunksProcessed += r.chunksProcessed;
  into.attempted += r.attempted;
  into.succeeded += r.succeeded;
  into.alreadyFollowing += r.alreadyFollowing;
  into.skipped += r.skipped;
  into.failed += r.failed;
  into.notes.push(...r.notes);
}

function mergeUnfollow(into: UnfollowDispatchResult, r: UnfollowDispatchResult) {
  for (const key of Object.keys(r) as (keyof UnfollowDispatchResult)[]) {
    if (key === "notes") continue;
    const a = into[key];
    const b = r[key];
    if (typeof a === "number" && typeof b === "number") {
      (into as unknown as Record<string, number>)[key] = a + b;
    }
  }
  into.notes.push(...r.notes);
}

export async function dispatchFairly(
  input: FairDispatchInput = {},
): Promise<FairDispatchResult> {
  const monotonic = input.monotonicNowMs ?? (() => Date.now());
  const startedAt = monotonic();
  const deadline = input.deadlineMs ?? DEFAULT_TICK_DEADLINE_MS;
  const chunkCost = input.chunkCostMs ?? CHUNK_COST_MS;
  const settle = input.settleMarginMs ?? SETTLE_MARGIN_MS;
  const remaining = () => deadline - (monotonic() - startedAt);
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const nowIso = now.toISOString();

  const result: FairDispatchResult = {
    deadlineMs: deadline,
    rounds: 0,
    served: [],
    deferred: [],
    follow: emptyFollow(),
    unfollow: {
      campaignsConsidered: 0,
      campaignsRun: 0,
      chunksProcessed: 0,
      attempted: 0,
      succeeded: 0,
      alreadyNotFollowing: 0,
      protectedCount: 0,
      conflicts: 0,
      skipped: 0,
      failed: 0,
      notes: [],
    },
    notes: [],
  };

  const maxRounds = input.maxRounds ?? Number.POSITIVE_INFINITY;
  for (let round = 1; round <= maxRounds; round += 1) {
    let due: Due[];
    try {
      due = await listDueRound(input, nowIso);
    } catch (err) {
      result.notes.push(
        `Could not list due campaigns: ${err instanceof Error ? err.message : "unknown"}`,
      );
      break;
    }
    if (due.length === 0) break;
    result.rounds = round;

    let ranAny = false;
    for (const campaign of due) {
      if (remaining() < chunkCost + settle) {
        result.notes.push(
          `deadline: ${Math.max(0, Math.round(remaining() / 1000))}s left is under one chunk (${Math.round((chunkCost + settle) / 1000)}s); the next delivery continues`,
        );
        for (const rest of due.slice(due.indexOf(campaign))) {
          result.deferred.push({ campaignId: rest.id, kind: rest.kind, reason: "deadline" });
        }
        return result;
      }

      if (campaign.kind === "unfollow") {
        const priority = await followHasPriority(campaign, due, now, input.db);
        if (priority.yield) {
          result.deferred.push({ campaignId: campaign.id, kind: "unfollow", reason: priority.reason ?? "follow priority" });
          result.notes.push(`${campaign.name}: ${priority.reason}`);
          continue;
        }
      }

      // The rotation is persisted by the dispatcher itself, through
      // this hook, at the one moment it is true: after the worker holds
      // the run's dispatch lease and a usable session, before its first
      // provider call. Recording it earlier — as the first version did,
      // before the dispatcher had even looked at the campaign — stamped
      // a campaign that was then NOT served (identity waiting for the
      // operator, another dispatcher holding the lease, outside its
      // window) as served, and every tick pushed it further behind the
      // others. Recording it later, after the chunk, would let a killed
      // invocation serve the same campaign first again. Here, a killed
      // invocation has already moved the campaign to the back, and a
      // campaign that could not be served keeps its place.
      const beforeFirstChunk = async () => {
        await touchCampaignDispatched({
          workspaceId: campaign.workspace_id,
          campaignId: campaign.id,
          nowIso: new Date(now.getTime() + (monotonic() - startedAt)).toISOString(),
          db: input.db,
        });
      };

      const budgetMs = Math.max(0, remaining() - settle);
      const passthrough = {
        db: input.db,
        nowIso,
        campaignId: campaign.id,
        workspaceId: campaign.workspace_id,
        maxChunks: 1,
        budgetMs,
        beforeFirstChunk,
        appView: input.appView,
        fetchImpl: input.fetchImpl,
        sleep: input.sleep,
        interRequestMs: input.interRequestMs,
        monotonicNowMs: input.monotonicNowMs,
        currentTime: input.currentTime,
      };
      if (campaign.kind === "follow") {
        const r = await dispatchCampaigns(passthrough);
        mergeFollow(result.follow, r);
        if (r.chunksProcessed > 0) {
          ranAny = true;
          result.served.push({ campaignId: campaign.id, kind: "follow", round });
        }
      } else {
        const r = await dispatchUnfollowCampaigns(passthrough);
        mergeUnfollow(result.unfollow, r);
        if (r.chunksProcessed > 0) {
          ranAny = true;
          result.served.push({ campaignId: campaign.id, kind: "unfollow", round });
        }
      }
    }

    // A round in which nobody could run — every campaign outside its
    // window, leased elsewhere, or out of quota — must not spin.
    if (!ranAny) break;
  }

  return result;
}
