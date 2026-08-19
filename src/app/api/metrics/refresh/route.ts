import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  buildLiveRefreshDeps,
  DEFAULT_SEED_WINDOW_DAYS,
  persistSweepReport,
  refreshStaleMetrics,
  sweepLogLine,
  SweepReportBuilder,
  verifiedPlatforms,
} from "@/core/metrics/refresh";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Phase D.1G — metrics refresh endpoint.
 *
 * Triggered by Vercel Cron (see vercel.json) once per day, or by curl.
 * Re-fetches verified metrics for due posts and seeds first fetches for
 * newly-published verified-platform posts.
 *
 * Auth: same shared-secret convention as the publishing scheduler tick
 * and the notification digest — `Authorization: Bearer <secret>`, where
 * <secret> is CRON_SECRET (what Vercel Cron sends) or
 * SCHEDULER_TICK_TOKEN (manual/curl). Neither env set → 503; mismatch →
 * 401. Added to the middleware public-path list (like /api/scheduler) so
 * the /login redirect doesn't intercept; the secret is the real gate. No
 * UI access.
 *
 * Isolation: this route touches the metrics subsystem ONLY. It never
 * publishes, never changes execution items / approvals / notifications,
 * and the persist layer never overwrites verified counts with empties.
 *
 * Observability: every response carries the full `report`, and the run
 * is written to `activity_events` per workspace. The 503 below is now
 * ALSO reported rather than returned bare — an unset service-role key
 * was one of the live hypotheses for why `post_metrics` stayed empty,
 * and a bare 503 tells an operator nothing they can act on.
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
  const auth = authorizeCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const staleLimit = clampInt(url.searchParams.get("staleLimit"), 100, 1, 500);
  const seedLimit = clampInt(url.searchParams.get("seedLimit"), 50, 0, 500);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const deps = buildLiveRefreshDeps();
  if (!deps) {
    // Report the misconfiguration in the same shape as a real run, so
    // whatever reads sweep output sees a cause rather than a gap.
    const report = new SweepReportBuilder({
      runId,
      startedAt,
      seedWindowDays: DEFAULT_SEED_WINDOW_DAYS,
      staleLimit,
      seedLimit,
      verifiedPlatforms: verifiedPlatforms(),
    }).fail(
      new Date().toISOString(),
      "SUPABASE_SERVICE_ROLE_KEY is unset in this environment, so the sweep " +
        "cannot open a database connection. No posts were considered.",
    );
    console.error(sweepLogLine(report));
    return NextResponse.json(
      {
        ok: false,
        error:
          "Metrics refresh unavailable: SUPABASE_SERVICE_ROLE_KEY is unset.",
        report,
      },
      { status: 503 },
    );
  }

  try {
    const result = await refreshStaleMetrics(deps, {
      staleLimit,
      seedLimit,
      seedWindowDays: DEFAULT_SEED_WINDOW_DAYS,
      runId,
    });
    console.log(sweepLogLine(result.report));

    // Best-effort audit write. A failure here is reported, never thrown —
    // losing the audit row must not lose the measurements.
    let persisted = null;
    const db = createSupabaseServiceRoleClient();
    if (db) persisted = await persistSweepReport(db, result.report);

    return NextResponse.json({ ...result, persisted });
  } catch (err) {
    const report = new SweepReportBuilder({
      runId,
      startedAt,
      seedWindowDays: DEFAULT_SEED_WINDOW_DAYS,
      staleLimit,
      seedLimit,
      verifiedPlatforms: verifiedPlatforms(),
    }).fail(new Date().toISOString(), err);
    console.error(sweepLogLine(report));
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Metrics refresh failed.",
        report,
      },
      { status: 500 },
    );
  }
}
