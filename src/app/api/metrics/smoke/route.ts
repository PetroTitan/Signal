import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { runProviderSmokeTest } from "@/core/metrics/smoke/provider-smoke";
import { verifiedPlatforms } from "@/core/metrics/refresh";

/**
 * Read-only provider smoke test.
 *
 * Verifies the measurement path against a REAL publication without
 * writing anything. Persistence is a dry run over the pure write
 * planner, so the provider can be checked in isolation from production —
 * which is what the activation runbook needs before anything is enabled.
 *
 * POST only, behind the same operator secret as the sweep. There is no
 * path from here to a publisher, and nothing is persisted.
 *
 * Body: { publishHistoryId?: string, platform?: string }
 * With no body it picks the most recent successful publication per
 * verified platform, which is the common case during activation.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface Body {
  publishHistoryId?: unknown;
  platform?: unknown;
}

export async function POST(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  let body: Body = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();
  if (!db) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Smoke test unavailable: SUPABASE_SERVICE_ROLE_KEY is unset, so the target publication cannot be resolved.",
      },
      { status: 503 },
    );
  }

  const platform =
    typeof body.platform === "string" ? body.platform : null;
  if (platform && !verifiedPlatforms().includes(platform)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unknown or unverified platform "${platform}". Verified: ${verifiedPlatforms().join(", ")}.`,
      },
      { status: 400 },
    );
  }

  let query = db
    .from("publish_history")
    .select(
      "id, workspace_id, platform, account_id, provider_post_id, provider_permalink, finished_at, growth_accounts(handle)",
    )
    .eq("outcome", "published")
    .not("provider_post_id", "is", null)
    .order("finished_at", { ascending: false })
    .limit(platform || body.publishHistoryId ? 1 : 10);

  if (typeof body.publishHistoryId === "string") {
    query = query.eq("id", body.publishHistoryId);
  }
  if (platform) query = query.eq("platform", platform);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    workspace_id: string;
    platform: string;
    account_id: string | null;
    provider_post_id: string | null;
    provider_permalink: string | null;
    finished_at: string;
    growth_accounts: { handle: string | null } | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No successful publication with a provider post id was found to test against.",
      },
      { status: 404 },
    );
  }

  // One target per platform — testing ten Bluesky posts proves nothing
  // the first did not, and on X each extra target is a billable read.
  const byPlatform = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!byPlatform.has(row.platform)) byPlatform.set(row.platform, row);
  }

  const nowIso = new Date().toISOString();
  const results = [];
  for (const row of byPlatform.values()) {
    results.push({
      publishHistoryId: row.id,
      publishedAt: row.finished_at,
      ...(await runProviderSmokeTest(
        {
          platform: row.platform,
          expectedProviderPostId: row.provider_post_id,
          permalink: row.provider_permalink,
          handle: row.growth_accounts?.handle ?? null,
        },
        {
          db,
          workspaceId: row.workspace_id,
          accountId: row.account_id,
          nowIso,
        },
      )),
    });
  }

  const ok = results.every((r) => r.ok);
  console.log(
    JSON.stringify({
      tag: "metrics-smoke",
      ok,
      platforms: results.map((r) => `${r.platform}:${r.ok ? "pass" : "fail"}`),
    }),
  );

  return NextResponse.json({
    ok,
    mode: "read_only",
    note: "Nothing was written and nothing was published. Persistence was a dry run.",
    results,
  });
}
