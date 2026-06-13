import { NextResponse } from "next/server";
import {
  buildLiveRefreshDeps,
  refreshStaleMetrics,
} from "@/core/metrics/refresh";

/**
 * Phase D.1G — metrics refresh endpoint.
 *
 * Triggered by Vercel Cron (see vercel.json) once per day, or by curl.
 * Re-fetches verified metrics for due posts and seeds first fetches for
 * newly-published verified-platform posts.
 *
 * Auth: same shared-secret convention as the publishing scheduler tick
 * and the notification digest — `Authorization: Bearer
 * <SCHEDULER_TICK_TOKEN>`. Unset env → 503; mismatch → 401. Added to the
 * middleware public-path list (like /api/scheduler) so the /login
 * redirect doesn't intercept; the secret is the real gate. No UI access.
 *
 * Isolation: this route touches the metrics subsystem ONLY. It never
 * publishes, never changes execution items / approvals / notifications,
 * and the persist layer never overwrites verified counts with empties.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Metrics fetches are network-bound (one provider call per post). 300s
// is the Vercel Pro ceiling; Hobby clamps. The engine bounds the batch.
export const maxDuration = 300;

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function GET(request: Request) {
  const secret = process.env.SCHEDULER_TICK_TOKEN?.trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Metrics refresh not configured: SCHEDULER_TICK_TOKEN is unset." },
      { status: 503 },
    );
  }
  const provided = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(provided.trim());
  if (!match || match[1] !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const deps = buildLiveRefreshDeps();
  if (!deps) {
    return NextResponse.json(
      { ok: false, error: "Metrics refresh unavailable: SUPABASE_SERVICE_ROLE_KEY is unset." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const staleLimit = clampInt(url.searchParams.get("staleLimit"), 100, 1, 500);
  const seedLimit = clampInt(url.searchParams.get("seedLimit"), 50, 0, 500);

  try {
    const result = await refreshStaleMetrics(deps, { staleLimit, seedLimit });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Metrics refresh failed." },
      { status: 500 },
    );
  }
}
