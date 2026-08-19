import "server-only";
/**
 * Assemble the whole measurement-status picture, once.
 *
 * The operator UI and the MCP tools ask the same questions, so they read
 * the same assembler rather than each building their own view — two
 * implementations would eventually disagree about whether measurement is
 * healthy, and that disagreement would surface as a bug report nobody
 * could reproduce.
 *
 * Every query is workspace-scoped. Run history is not: a sweep spans
 * workspaces and its record deliberately carries no workspace identifier.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import { loadRefreshRunHistory } from "@/repositories/metrics-refresh-run-repository";
import { verifiedPlatforms, DEFAULT_SEED_WINDOW_DAYS } from "../refresh";
import { evaluateRefreshHealth, type RefreshHealth } from "./refresh-health";
import { evaluateAlerts, worstSeverity, type Alert, type AlertSeverity } from "./alerts";
import {
  summarizeCoverage,
  type CoverageSummary,
  type PublicationForCoverage,
} from "../coverage";
import { planRefreshBatch, type RefreshPlan } from "../refresh-planner";
import {
  evaluateBudget,
  resolveBudgets,
  type BudgetState,
} from "../budget/x-read-budget";
import { readingAgeHours } from "../freshness";
import { isSnapshottable } from "../account-snapshot-collector";
import type { AgeWindow } from "../age-windows";

export interface AccountContextView {
  accountId: string;
  platform: string;
  handle: string | null;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  fetchedAt: string | null;
  ageHours: number | null;
  freshness: string | null;
  error: string | null;
}

export interface MeasurementStatus {
  health: RefreshHealth;
  coverage: CoverageSummary[];
  accounts: AccountContextView[];
  alerts: Alert[];
  worstAlert: AlertSeverity | null;
  budget: BudgetState;
  plan: RefreshPlan;
  /** True when nothing has ever been published in this workspace. */
  empty: boolean;
  nowIso: string;
}

export async function loadMeasurementStatus(
  workspaceId: string,
  options: { nowIso?: string; db?: SupabaseClient } = {},
): Promise<MeasurementStatus> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const supabase = options.db ?? createSupabaseServerClient();
  const platforms = verifiedPlatforms();

  const [publications, metricsRows, snapshotRows, history, xSpentToday] =
    await Promise.all([
      loadPublications(supabase, workspaceId),
      loadMetrics(supabase, workspaceId),
      loadAccountSnapshots(supabase, workspaceId),
      loadRefreshRunHistory(supabase, 20),
      loadXSpendToday(supabase, nowIso),
    ]);

  const metricsByPost = new Map(metricsRows.map((m) => [m.publishHistoryId, m]));

  const forCoverage: PublicationForCoverage[] = publications.map((p) => {
    const m = metricsByPost.get(p.id);
    return {
      publishHistoryId: p.id,
      platform: p.platform,
      accountId: p.accountId,
      outcome: p.outcome,
      publishedAt: p.finishedAt,
      providerPostId: p.providerPostId,
      permalink: p.permalink,
      metrics: m
        ? {
            status: m.status,
            fetchedAt: m.fetchedAt,
            freshness: m.freshness,
            ageWindow: m.ageWindow,
            counters: m.counters,
          }
        : null,
    };
  });

  const coverageOptions = { nowIso, seedWindowDays: DEFAULT_SEED_WINDOW_DAYS };
  const coverage = summarizeCoverage(forCoverage, coverageOptions);

  const health = evaluateRefreshHealth({
    history,
    nowIso,
    verifiedPlatforms: platforms,
  });

  // What the next sweep would do, per post.
  const plan = planRefreshBatch(
    publications
      .filter((p) => p.outcome === "published")
      .map((p) => ({
        publishHistoryId: p.id,
        platform: p.platform,
        publishedAt: p.finishedAt,
        hasProviderId: Boolean(p.providerPostId ?? p.permalink),
        coveredWindows: (metricsByPost.get(p.id)?.windows ?? []) as AgeWindow[],
        lastReadAt: metricsByPost.get(p.id)?.fetchedAt ?? null,
      })),
    coverageOptions,
  );

  const accounts: AccountContextView[] = snapshotRows.map((s) => ({
    accountId: s.accountId,
    platform: s.platform,
    handle: s.handle,
    followers: s.followers,
    following: s.following,
    postCount: s.postCount,
    fetchedAt: s.fetchedAt,
    ageHours: readingAgeHours(s.fetchedAt, nowIso),
    freshness: s.freshness,
    error: s.error,
  }));

  const budget = evaluateBudget(
    xSpentToday,
    resolveBudgets({
      dailyXReads: process.env.SIGNAL_DAILY_X_READ_BUDGET ?? null,
      backfillXReads: process.env.SIGNAL_BACKFILL_X_READ_BUDGET ?? null,
    }).dailyXReads,
  );

  const newestAccountAge = accounts
    .map((a) => a.ageHours)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)[0] ?? null;

  const alerts = evaluateAlerts({
    health,
    coverage,
    budget,
    accountSnapshotAgeHours: newestAccountAge,
    hasSnapshottableAccounts: publications.some((p) => isSnapshottable(p.platform)),
    nowIso,
  });

  return {
    health,
    coverage,
    accounts,
    alerts,
    worstAlert: worstSeverity(alerts),
    budget,
    plan,
    empty: publications.length === 0,
    nowIso,
  };
}

// ---------------------------------------------------------------------

interface PublicationRow {
  id: string;
  platform: string;
  accountId: string | null;
  outcome: string;
  finishedAt: string;
  providerPostId: string | null;
  permalink: string | null;
}

async function loadPublications(
  db: SupabaseClient,
  workspaceId: string,
): Promise<PublicationRow[]> {
  const { data } = await db
    .from("publish_history")
    .select("id, platform, account_id, outcome, finished_at, provider_post_id, provider_permalink")
    .eq("workspace_id", workspaceId)
    .order("finished_at", { ascending: false })
    .limit(500);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    platform: String(r.platform),
    accountId: (r.account_id as string) ?? null,
    outcome: String(r.outcome),
    finishedAt: String(r.finished_at),
    providerPostId: (r.provider_post_id as string) ?? null,
    permalink: (r.provider_permalink as string) ?? null,
  }));
}

interface MetricsRow {
  publishHistoryId: string;
  status: string;
  fetchedAt: string | null;
  freshness: string | null;
  ageWindow: string | null;
  counters: Record<string, unknown>;
  /** Windows this post has any reading for, canonical + snapshots. */
  windows: string[];
}

async function loadMetrics(
  db: SupabaseClient,
  workspaceId: string,
): Promise<MetricsRow[]> {
  const { data } = await db
    .from("post_metrics")
    .select("publish_history_id, source, status, metrics, fetched_at, freshness, age_window")
    .eq("workspace_id", workspaceId)
    .limit(2000);

  const canonical = new Map<string, MetricsRow>();
  const windows = new Map<string, Set<string>>();

  for (const raw of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const id = String(raw.publish_history_id);
    const source = String(raw.source);
    const ageWindow = (raw.age_window as string) ?? null;
    if (ageWindow) {
      const set = windows.get(id) ?? new Set<string>();
      set.add(ageWindow);
      windows.set(id, set);
    }
    if (source.startsWith("snapshot:")) continue;
    canonical.set(id, {
      publishHistoryId: id,
      status: String(raw.status),
      fetchedAt: (raw.fetched_at as string) ?? null,
      freshness: (raw.freshness as string) ?? null,
      ageWindow,
      counters: (raw.metrics as Record<string, unknown>) ?? {},
      windows: [],
    });
  }

  for (const [id, row] of canonical) {
    row.windows = Array.from(windows.get(id) ?? []);
  }
  return Array.from(canonical.values());
}

interface SnapshotRow {
  accountId: string;
  platform: string;
  handle: string | null;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  fetchedAt: string;
  freshness: string;
  error: string | null;
}

async function loadAccountSnapshots(
  db: SupabaseClient,
  workspaceId: string,
): Promise<SnapshotRow[]> {
  const { data } = await db
    .from("account_snapshots")
    .select("account_id, platform, handle, followers, following, post_count, fetched_at, source, freshness, error")
    .eq("workspace_id", workspaceId)
    .order("fetched_at", { ascending: false })
    .limit(200);

  const latest = new Map<string, SnapshotRow>();
  for (const raw of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    if (String(raw.source).startsWith("snapshot:")) continue;
    const accountId = String(raw.account_id);
    if (latest.has(accountId)) continue;
    latest.set(accountId, {
      accountId,
      platform: String(raw.platform),
      handle: (raw.handle as string) ?? null,
      followers: (raw.followers as number) ?? null,
      following: (raw.following as number) ?? null,
      postCount: (raw.post_count as number) ?? null,
      fetchedAt: String(raw.fetched_at),
      freshness: String(raw.freshness),
      error: (raw.error as string) ?? null,
    });
  }
  return Array.from(latest.values());
}

async function loadXSpendToday(db: SupabaseClient, nowIso: string): Promise<number> {
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  try {
    const { sumXResourcesSince } = await import(
      "@/repositories/metrics-refresh-run-repository"
    );
    return await sumXResourcesSince(db, dayStart);
  } catch {
    // Budget accounting is advisory context; never fail the whole page.
    return 0;
  }
}
