import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import {
  dispatchFairly,
  tickDeadlineMs,
} from "@/core/bluesky-campaigns/dispatch-round.server";
import { isGloballyDisabledByEnv } from "@/core/bluesky-campaigns/kill-switch.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Bluesky campaign dispatcher endpoint — follow AND unfollow.
 *
 * Called by Vercel Cron. Authenticated by the SAME shared-secret helper
 * the existing scheduler, digest and metrics crons use — `CRON_SECRET`
 * (what Vercel sends) or `SCHEDULER_TICK_TOKEN` (manual), compared in
 * constant time, 503 when unconfigured and 401 on mismatch. It is never
 * a silent no-op.
 *
 * A SEPARATE cron from `/api/scheduler/tick` on purpose: publishing and
 * following must not share a duration budget or a failure mode. A slow
 * publish must not eat the follow window, and a campaign fault must not
 * stop the publisher.
 *
 * ONE DELIVERY, SHARED FAIRLY
 * ---------------------------
 * Both kinds of campaign compete for the same per-identity daily
 * budget and the same provider request limit, so they run inside ONE
 * invocation and take turns rather than discovering contention in
 * parallel. The turn-taking is `dispatchFairly`: rounds, at most one
 * chunk per campaign per round, ordered by when each campaign was last
 * served (persisted, so the order survives between deliveries), with
 * another round only while safe time remains.
 *
 * Follow's priority over unfollow is a QUOTA rule, not an ordering:
 * an unfollow campaign stands aside only when the identity's remaining
 * budget today is no more than what the due follow campaigns on it
 * still need. When the budget is fine, both kinds progress every
 * delivery. The previous shape — follow first with the whole budget —
 * starved unfollow whenever a follow campaign was continuously due.
 *
 * THE DEADLINE
 * ------------
 * `maxDuration = 300` is declared, but a platform may clamp it (Vercel
 * Hobby: 60 s) and the plan this project deploys under was not
 * verifiable from the repository. The dispatcher therefore assumes a
 * 60-second ceiling unless `BLUESKY_TICK_BUDGET_MS` says otherwise, and
 * stops CLAIMING new work once less than one chunk's cost remains — a
 * claimed chunk is always settled or released by its own code. Under
 * the default that is about one 20-member chunk per delivery; a
 * 300/day campaign is 300 spread across the day's deliveries, never
 * 300 in one request. See docs/relationships/campaigns-runbook.md.
 *
 * REPLAY PROTECTION
 * -----------------
 * The bearer secret alone authenticates the caller but does not make a
 * REPLAYED request harmless. That is handled where it actually matters
 * rather than with a nonce cache that a serverless deployment cannot
 * share:
 *
 *   - the day's run is unique per (campaign, local_date), so a replay
 *     finds the existing run;
 *   - claiming is `FOR UPDATE SKIP LOCKED`, so a replay racing the real
 *     request claims different rows, not the same ones;
 *   - one action per (campaign, member) is a unique index, so no member
 *     can be followed or unfollowed twice however many times this
 *     endpoint is hit;
 *   - the daily quota is consumed in the database, so N replays cannot
 *     attempt N times the approved volume;
 *   - the dispatch lease is one dispatcher per campaign-day.
 *
 * Method: GET, to match the existing cron routes and because Vercel
 * Cron issues GET. It takes no body and no client-supplied workspace,
 * campaign, quota or deadline: everything is read from the database
 * and the deployment's own environment.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 300 s is the Vercel Pro ceiling and matches `/api/scheduler/tick`.
 * It is NOT what the dispatcher plans against — `tickDeadlineMs` is —
 * so a platform clamp to 60 s cannot kill a chunk mid-flight.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }

  // The deploy-level kill switch is checked here as well as in the
  // dispatcher, so an incident does not depend on the database being
  // reachable to stop the system.
  if (isGloballyDisabledByEnv()) {
    return NextResponse.json({
      ok: true,
      disabled: true,
      reason:
        "BLUESKY_CAMPAIGNS_DISABLED is set for this deployment. No campaign was considered.",
    });
  }

  const db = createSupabaseServiceRoleClient();
  if (!db) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Automatic following is not configured: SUPABASE_SERVICE_ROLE_KEY is missing.",
      },
      { status: 503 },
    );
  }

  try {
    const round = await dispatchFairly({
      db,
      deadlineMs: tickDeadlineMs(process.env),
    });
    return NextResponse.json({
      ok: true,
      deadlineMs: round.deadlineMs,
      rounds: round.rounds,
      served: round.served,
      deferred: round.deferred,
      // Kept flat for the follow figures, as before, so anything reading
      // the old shape still finds them.
      ...round.follow,
      unfollow: round.unfollow,
      notes: [...round.notes, ...round.follow.notes],
    });
  } catch (err) {
    // Deliberately a 200 with ok:false rather than a 500. A cron
    // endpoint that 500s invites platform-level retries on top of the
    // schedule, which is the opposite of what a rate-limited provider
    // needs. The failure is reported, not amplified.
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Campaign dispatch failed.",
    });
  }
}
