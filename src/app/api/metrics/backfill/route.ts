import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { verifiedPlatforms } from "@/core/metrics/refresh";
import {
  buildLiveBackfillDeps,
  describePlan,
  executePlan,
  MAX_BACKFILL_POSTS,
  planBackfill,
  type BackfillCandidate,
} from "@/core/metrics/backfill";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { listBackfillCandidates } from "@/repositories/post-metrics-repository";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * Bounded historical metrics backfill.
 *
 * WHY THIS IS NOT THE NIGHTLY SWEEP
 * ---------------------------------
 * The sweep enrols only publications inside a rolling 14-day window,
 * which is the right default for a cron. Everything published before
 * that window was therefore never measured and never would be. Widening
 * the sweep would make every nightly run re-scan the whole history
 * forever, so recovery is a separate, deliberately-invoked operation.
 *
 * CONTRACT
 * --------
 *   - POST only. A GET cannot spend money by accident, and a cron cannot
 *     trigger this by following the same convention as the sweep.
 *   - Auth: the shared cron/operator bearer secret, same as the sweep.
 *   - DRY RUN BY DEFAULT. Without `execute: true` this returns the plan,
 *     the cost estimate and the spend verdict, and touches no provider.
 *   - A run that costs money requires `confirmedMaxUsd` >= the estimate.
 *   - A platform with no documented cost rate blocks a live run entirely.
 *   - Read-only against providers. It shares the sweep's metric fetchers;
 *     there is no path from here to a publisher.
 *
 * Body (all optional except as noted):
 *   { since?: ISO, until?: ISO, maxPosts?: number, platforms?: string[],
 *     includeAlreadyMeasured?: boolean, execute?: boolean,
 *     confirmedMaxUsd?: number }
 *
 * `since` defaults to the beginning of Signal's records rather than to a
 * rolling window — the point of this endpoint is to reach what the
 * window excludes.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Signal has no publications before this; a sane, explicit floor. */
const EPOCH_FLOOR = "2020-01-01T00:00:00.000Z";

interface BackfillBody {
  since?: unknown;
  until?: unknown;
  maxPosts?: unknown;
  platforms?: unknown;
  includeAlreadyMeasured?: unknown;
  execute?: unknown;
  confirmedMaxUsd?: unknown;
}

function isoOr(value: unknown, fallback: string): string | null {
  if (value == null) return fallback;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function POST(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: BackfillBody = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as BackfillBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body must be JSON." },
      { status: 400 },
    );
  }

  const nowIso = new Date().toISOString();
  const since = isoOr(body.since, EPOCH_FLOOR);
  const until = isoOr(body.until, nowIso);
  if (!since || !until) {
    return NextResponse.json(
      { ok: false, error: "`since` and `until` must be ISO-8601 timestamps." },
      { status: 400 },
    );
  }
  if (since >= until) {
    return NextResponse.json(
      { ok: false, error: "`since` must be earlier than `until`." },
      { status: 400 },
    );
  }

  const allPlatforms = verifiedPlatforms();
  const requested = Array.isArray(body.platforms)
    ? body.platforms.filter((p): p is string => typeof p === "string")
    : [];
  const unknown = requested.filter((p) => !allPlatforms.includes(p));
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unknown or unverified platform(s): ${unknown.join(", ")}. Verified: ${allPlatforms.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const platforms = requested.length > 0 ? requested : allPlatforms;

  const maxPosts =
    typeof body.maxPosts === "number" && Number.isFinite(body.maxPosts)
      ? Math.max(1, Math.min(MAX_BACKFILL_POSTS, Math.floor(body.maxPosts)))
      : MAX_BACKFILL_POSTS;
  const confirmedMaxUsd =
    typeof body.confirmedMaxUsd === "number" && Number.isFinite(body.confirmedMaxUsd)
      ? body.confirmedMaxUsd
      : null;
  const execute = body.execute === true;

  const db = createSupabaseServiceRoleClient();
  if (!db) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Backfill unavailable: SUPABASE_SERVICE_ROLE_KEY is unset in this environment.",
      },
      { status: 503 },
    );
  }

  let candidates: BackfillCandidate[];
  try {
    candidates = await listBackfillCandidates(db, platforms, since, until, 2000);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to load candidates.",
      },
      { status: 500 },
    );
  }

  const plan = planBackfill({
    candidates,
    bounds: {
      since,
      until,
      maxPosts,
      platforms: requested,
      includeAlreadyMeasured: body.includeAlreadyMeasured === true,
    },
    confirmedMaxUsd,
  });

  const planView = {
    bounds: plan.bounds,
    selected: plan.selected.length,
    rejected: plan.rejected.length,
    batches: plan.batches.length,
    postsByPlatform: plan.postsByPlatform,
    cost: plan.cost,
    costSummary: plan.costSummary,
    gate: plan.gate,
    executable: plan.executable,
    description: describePlan(plan),
  };

  if (!execute) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      plan: planView,
      hint:
        "No provider was contacted and nothing was written. Re-send with " +
        '`"execute": true` (plus `confirmedMaxUsd` if the plan costs money) to run it.',
    });
  }

  if (!plan.gate.allowed) {
    return NextResponse.json(
      { ok: false, mode: "refused", plan: planView, error: plan.gate.message },
      { status: 402 },
    );
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const result = await executePlan(plan, buildLiveBackfillDeps(db), {
    runId,
    startedAt,
  });

  console.log(
    JSON.stringify({
      tag: "metrics-backfill",
      runId,
      executed: result.executed,
      attempted: result.attempted,
      measured: result.measured,
      rateLimited: result.rateLimited,
      failed: result.failed,
      estimatedUsd: plan.cost.totalEstimatedUsd,
      summary: result.summary,
    }),
  );

  return NextResponse.json({
    ok: result.ok,
    mode: "executed",
    plan: planView,
    result,
  });
}
