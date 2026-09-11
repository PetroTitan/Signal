import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { dispatchCampaigns } from "@/core/bluesky-campaigns/dispatcher.server";
import { isGloballyDisabledByEnv } from "@/core/bluesky-campaigns/kill-switch.server";

/**
 * Bluesky follow-campaign dispatcher endpoint.
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
 * REPLAY PROTECTION
 * -----------------
 * The bearer secret alone authenticates the caller but does not make a
 * REPLAYED request harmless — an attacker who captured one could send
 * it repeatedly. That is handled where it actually matters rather than
 * with a nonce cache that a serverless deployment cannot share:
 *
 *   - the day's run is unique per (campaign, local_date), so a replay
 *     finds the existing run;
 *   - claiming is `FOR UPDATE SKIP LOCKED`, so a replay racing the real
 *     request claims different rows, not the same ones;
 *   - one action per (campaign, member) is a unique index, so no member
 *     can be followed twice however many times this endpoint is hit;
 *   - the daily quota is consumed in the database, so N replays cannot
 *     attempt N times the approved volume.
 *
 * In other words a replay is bounded by the same invariants that make
 * at-least-once cron delivery safe — which is the only defence that
 * works when the attacker can also simply wait for the next real tick.
 *
 * Method: GET, to match the existing cron routes and because Vercel
 * Cron issues GET. It takes no body and no client-supplied workspace,
 * campaign or quota: everything is read from the database.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 300s is the Vercel Pro ceiling and matches `/api/scheduler/tick`. The
 * dispatcher stops its chunk loop at 240s, leaving a full minute to
 * persist the run's state and respond — being killed mid-write is the
 * only outcome that loses information rather than just time.
 *
 * On Hobby the platform clamps this to 60s. The system stays correct
 * (fewer chunks per tick, next delivery continues); it is simply
 * slower. See the runbook.
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

  try {
    const result = await dispatchCampaigns({});
    return NextResponse.json({ ok: true, ...result });
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
