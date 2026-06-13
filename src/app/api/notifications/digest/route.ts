import { NextResponse } from "next/server";
import {
  buildLiveDigestDeps,
  deliverDigests,
  type DigestCadenceWindow,
} from "@/core/notifications/deliver-digests";

/**
 * C2.1 — scheduled notification digest delivery endpoint.
 *
 * Triggered by Vercel Cron (see vercel.json) once per cadence window:
 *   - GET /api/notifications/digest?cadence=daily   (daily)
 *   - GET /api/notifications/digest?cadence=weekly  (weekly)
 *
 * Auth: same shared-secret convention as the publishing scheduler tick
 * — `Authorization: Bearer <SCHEDULER_TICK_TOKEN>`. If the env is unset
 * the route returns 503; on a mismatch it returns 401. It is added to
 * the middleware public-path list (like /api/scheduler) so the /login
 * redirect doesn't intercept the cron call; the secret is the real
 * gate. No public unauthenticated access.
 *
 * This route delivers notification digests ONLY. It never publishes,
 * never touches execution items / publish history / adapters, and never
 * marks notifications read.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Digest delivery is lightweight (a few reads + outbound sends per
// recipient). 60s is ample; Hobby clamps automatically.
export const maxDuration = 60;

function parseCadence(url: string): DigestCadenceWindow {
  const value = new URL(url).searchParams.get("cadence")?.trim().toLowerCase();
  return value === "weekly" ? "weekly" : "daily";
}

export async function GET(request: Request) {
  const secret = process.env.SCHEDULER_TICK_TOKEN?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: "Digest delivery not configured: SCHEDULER_TICK_TOKEN is unset.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(provided.trim());
  if (!match || match[1] !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const cadence = parseCadence(request.url);
  const deps = buildLiveDigestDeps();
  if (!deps) {
    return NextResponse.json(
      {
        ok: false,
        error: "Digest delivery unavailable: SUPABASE_SERVICE_ROLE_KEY is unset.",
      },
      { status: 503 },
    );
  }

  try {
    const result = await deliverDigests(cadence, deps);
    return NextResponse.json(result);
  } catch (err) {
    // deliverDigests never throws per-recipient; this is a last-resort
    // guard for an unexpected systemic failure.
    return NextResponse.json(
      {
        ok: false,
        cadence,
        error: err instanceof Error ? err.message : "Digest delivery failed.",
      },
      { status: 500 },
    );
  }
}
