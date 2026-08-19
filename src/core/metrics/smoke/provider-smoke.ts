import "server-only";
/**
 * Read-only provider smoke harness.
 *
 * Verifies that the measurement path works against a REAL publication,
 * end to end, without writing anything anywhere. It is the difference
 * between "the unit tests pass" and "the provider actually answers the
 * way the parser expects".
 *
 * TWO SEPARATE QUESTIONS, DELIBERATELY NOT MIXED
 * ----------------------------------------------
 *   provider read verification  — does the provider answer, and does the
 *                                 normalizer produce sane values?
 *   persistence verification    — would the persist layer accept it?
 *
 * The first needs a network and no database. The second needs neither: it
 * runs the PURE write planner over the fetched result and reports what
 * WOULD be written. So the provider can be verified without touching
 * production, which is exactly what an activation runbook needs.
 *
 * HARD CONSTRAINTS
 *   - Read-only. There is no code path from here to a publisher, and the
 *     only fetchers used are the ones the sweep uses.
 *   - Nothing is persisted. `persistence` is a dry run over pure logic.
 *   - No credential value is returned, logged, or embedded in a message.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVerifiedMetrics } from "../fetch-metrics";
import { fetchBlueskyAccountSnapshot } from "../account-snapshot-reader";
import {
  availableMetrics,
  metricAvailability,
  resolveMetricCell,
  supportsImpressions,
} from "../metric-availability";
import { classifyConfidence, classifyFreshness } from "../freshness";
import { resolveAge } from "../age-windows";
import { planRefreshWrite } from "@/repositories/post-metrics-repository";
import { redactSecrets } from "../refresh/sweep-report";
import type { MetricsResult } from "../metrics-provider";

export interface SmokeCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** Advisory checks do not fail the run — they report a condition. */
  advisory?: boolean;
}

export interface SmokeTarget {
  platform: string;
  /** The provider post id Signal recorded at publish time. */
  expectedProviderPostId: string | null;
  permalink: string | null;
  /** Bluesky profile handle, when the account check is wanted. */
  handle?: string | null;
}

export interface SmokeResult {
  platform: string;
  ok: boolean;
  providerReadOk: boolean;
  persistenceOk: boolean;
  checks: SmokeCheck[];
  /** Normalized counters, for eyeballing. No raw provider payload. */
  normalized: Record<string, number> | null;
  summary: string;
}

export interface SmokeDeps {
  /** Present only when the platform needs a token (X). */
  db?: SupabaseClient;
  workspaceId?: string;
  accountId?: string | null;
  nowIso?: string;
  fetchMetrics?: typeof fetchVerifiedMetrics;
  fetchProfile?: typeof fetchBlueskyAccountSnapshot;
}

export async function runProviderSmokeTest(
  target: SmokeTarget,
  deps: SmokeDeps = {},
): Promise<SmokeResult> {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const checks: SmokeCheck[] = [];
  const fetchMetrics = deps.fetchMetrics ?? fetchVerifiedMetrics;

  // ---- provider read ------------------------------------------------
  let result: MetricsResult;
  try {
    result = await fetchMetrics({
      platform: target.platform,
      externalPostId: target.expectedProviderPostId,
      permalink: target.permalink,
      auth:
        deps.db && deps.workspaceId
          ? {
              db: deps.db,
              workspaceId: deps.workspaceId,
              accountId: deps.accountId ?? null,
              nowIso,
            }
          : null,
    });
  } catch (err) {
    return failed(target.platform, [
      {
        name: "provider read",
        passed: false,
        detail: `The read threw: ${redactSecrets(err)}`,
      },
    ]);
  }

  checks.push({
    name: "provider responded",
    passed: result.status !== "unsupported",
    detail:
      result.status === "unsupported"
        ? "Signal does not read metrics for this platform."
        : `Status "${result.status}"${result.error ? ` — ${redactSecrets(result.error)}` : ""}.`,
  });

  const connected = result.status === "connected";
  checks.push({
    name: "post exists and returned counters",
    passed: connected,
    detail: connected
      ? "The provider returned the post with counters."
      : `No counters returned${result.error ? `: ${redactSecrets(result.error)}` : "."}`,
  });

  checks.push({
    name: "provider post id matches what Signal recorded",
    passed:
      !target.expectedProviderPostId ||
      result.externalPostId === target.expectedProviderPostId,
    detail:
      result.externalPostId === target.expectedProviderPostId
        ? "The id returned matches publish_history."
        : `Recorded "${target.expectedProviderPostId}", provider echoed "${result.externalPostId}".`,
  });

  // ---- normalization -------------------------------------------------
  const expected = availableMetrics(target.platform);
  const counters = result.metrics as Record<string, number | undefined>;
  const present = expected.filter((k) => typeof counters[k] === "number");

  checks.push({
    name: "every counter is a non-negative integer",
    passed: Object.values(counters).every(
      (v) => v === undefined || (Number.isInteger(v) && (v as number) >= 0),
    ),
    detail: `Normalized ${present.length} of ${expected.length} counter(s) this platform reports.`,
  });

  checks.push({
    name: "no counter was invented",
    passed: Object.keys(counters).every((k) =>
      metricAvailability(target.platform, k as never) === "available",
    ),
    detail: `Keys returned: ${Object.keys(counters).join(", ") || "none"}.`,
  });

  // Platform-specific truth checks.
  if (target.platform === "bluesky") {
    checks.push({
      name: "bookmark counter is handled",
      passed: expected.includes("bookmarks"),
      detail: connected
        ? typeof counters.bookmarks === "number"
          ? `bookmarkCount read as ${counters.bookmarks}.`
          : "The AppView returned no bookmarkCount for this post."
        : "Not evaluated — no counters returned.",
      advisory: true,
    });

    const impressionCell = resolveMetricCell("bluesky", "impressions", result.metrics);
    checks.push({
      name: "impressions are unavailable, not zero",
      passed:
        !supportsImpressions("bluesky") &&
        impressionCell.kind === "unsupported" &&
        counters.impressions === undefined,
      detail: `Bluesky exposes no impressions; the cell renders "${impressionCell.kind === "value" ? impressionCell.value : impressionCell.reason}".`,
    });
  }

  if (target.platform === "x") {
    checks.push({
      name: "impressions are readable",
      passed: supportsImpressions("x"),
      detail: connected
        ? typeof counters.impressions === "number"
          ? `impression_count read as ${counters.impressions}.`
          : "public_metrics came back without impression_count."
        : "Not evaluated — no counters returned.",
      advisory: !connected,
    });
  }

  // ---- provenance ----------------------------------------------------
  const { ageHours, ageWindow } = resolveAge(result.providerPublishedAt ?? null, nowIso);
  const freshness = classifyFreshness({
    fetchedAtIso: nowIso,
    nowIso,
    status: result.status,
    rateLimited: result.rateLimited,
  });
  const confidence = classifyConfidence(expected, counters);

  checks.push({
    name: "freshness assigned",
    passed: Boolean(freshness),
    detail: `freshness="${freshness}", confidence="${confidence}", ageWindow=${ageWindow ?? "unknown"}${ageHours != null ? ` (${ageHours}h)` : ""}.`,
  });

  // ---- persistence DRY RUN -------------------------------------------
  // Pure planner over the fetched result. Nothing is written; this
  // answers "would the persist layer accept this?" without touching
  // production, which is what lets the provider be verified in isolation.
  const plan = planRefreshWrite(null, {
    status: result.status,
    metrics: result.metrics as Record<string, unknown>,
  });
  const persistenceOk = connected ? plan.status === "connected" && plan.snapshot : true;
  checks.push({
    name: "persistence path accepts the result (dry run)",
    passed: persistenceOk,
    detail: connected
      ? `Would write status="${plan.status}" and ${plan.snapshot ? "an" : "no"} immutable snapshot. Nothing was written.`
      : `Non-connected result would write status="${plan.status}" without clobbering prior data. Nothing was written.`,
  });

  // ---- optional account read -----------------------------------------
  if (target.platform === "bluesky" && target.handle) {
    const fetchProfile = deps.fetchProfile ?? fetchBlueskyAccountSnapshot;
    try {
      const profile = await fetchProfile(target.handle, nowIso);
      checks.push({
        name: "account profile readable",
        passed: profile.ok,
        detail: profile.ok
          ? `followers=${profile.snapshot.followers ?? "unknown"}, following=${profile.snapshot.following ?? "unknown"}, posts=${profile.snapshot.postCount ?? "unknown"}.`
          : redactSecrets(profile.reason),
      });
    } catch (err) {
      checks.push({
        name: "account profile readable",
        passed: false,
        detail: redactSecrets(err),
      });
    }
  }

  const blocking = checks.filter((c) => !c.advisory);
  const providerReadOk = blocking
    .filter((c) => c.name !== "persistence path accepts the result (dry run)")
    .every((c) => c.passed);
  const ok = blocking.every((c) => c.passed);

  return {
    platform: target.platform,
    ok,
    providerReadOk,
    persistenceOk,
    checks,
    normalized: connected
      ? (Object.fromEntries(
          Object.entries(counters).filter(([, v]) => typeof v === "number"),
        ) as Record<string, number>)
      : null,
    summary: `${blocking.filter((c) => c.passed).length}/${blocking.length} checks passed for ${target.platform}. Nothing was written and nothing was published.`,
  };
}

function failed(platform: string, checks: SmokeCheck[]): SmokeResult {
  return {
    platform,
    ok: false,
    providerReadOk: false,
    persistenceOk: false,
    checks,
    normalized: null,
    summary: `Smoke test could not complete for ${platform}.`,
  };
}
