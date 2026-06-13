import { NextResponse } from "next/server";
import { tickOnce } from "@/core/publishing";

/**
 * Phase F1 — scheduler tick endpoint.
 *
 * Single one-shot batch runner. Designed to be called by Vercel Cron
 * (or curl) every few minutes. Gated by a fixed shared secret in the
 * `Authorization: Bearer <SCHEDULER_TICK_TOKEN>` header; if the env
 * is unset or the header doesn't match, returns 401 — the route
 * never silently no-ops.
 *
 * The endpoint does not require a Supabase session because the
 * scheduler operates as the workspace via the service-role client.
 * This route is added to the middleware's public path list so the
 * /login redirect doesn't intercept.
 *
 * Method: GET to ease cron triggering. The endpoint is idempotent in
 * the sense that it processes whatever's eligible at call time; it
 * doesn't accept a body.
 */

export const dynamic = "force-dynamic";

/**
 * A2 — explicit scheduler-tick duration budget.
 *
 * A single tick can, per item, refresh OAuth/identity tokens, fetch +
 * transcode media into a provider-safe derivative, make one or more
 * provider publish calls (a Bluesky thread is several round-trips at
 * up to 20–30s each), and write the outcome + history. The platform
 * default (~10–15s) is far too low for a batch of up to 10 items and
 * can kill the function MID-PUBLISH — exactly the crash window the A1
 * claim mechanism protects against, but better avoided entirely.
 *
 * 300s is the Vercel Pro/Enterprise serverless ceiling. On Hobby
 * (60s cap) the platform clamps this down; it does not break the
 * build. We do NOT raise the batch size in this phase. The Node
 * runtime is required (sharp + crypto + service-role client are not
 * Edge-compatible).
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.SCHEDULER_TICK_TOKEN?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: "Scheduler not configured: SCHEDULER_TICK_TOKEN is unset.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(provided.trim());
  if (!match || match[1] !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  try {
    const result = await tickOnce({});
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Scheduler tick failed.",
      },
      { status: 500 },
    );
  }
}
