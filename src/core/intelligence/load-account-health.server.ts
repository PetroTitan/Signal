import "server-only";
/**
 * Assemble the account-health surface from the database.
 *
 * Kept out of the page component so the page stays a renderer and the
 * assembly is testable on its own. Every query is workspace-scoped; this
 * runs under the operator's cookie session, so RLS applies too.
 */

import { createSupabaseServerClient } from "@/lib/supabase";
import { classifyFreshness, readingAgeHours, type Freshness } from "@/core/metrics/freshness";
import { engagementCount, type VerifiedMetrics } from "@/core/metrics/metrics-provider";
import type { AccountSnapshot } from "@/core/metrics/account-context";
import {
  buildAccountHealthPanel,
  recommendNextActions,
  type AccountHealthPanel,
  type Recommendation,
} from "@/core/intelligence";

export interface PlatformHealthView {
  panel: AccountHealthPanel;
  recommendations: Recommendation[];
  /** Everything published on this platform, for the counts row. */
  publishedCount: number;
  measuredCount: number;
  lastPublishedAt: string | null;
}

export interface AccountHealthView {
  platforms: PlatformHealthView[];
  /** True when no publication exists at all. */
  empty: boolean;
}

interface Row {
  id: string;
  platform: string;
  account_id: string | null;
  finished_at: string;
  execution_items: { title: string | null; body: string | null; link_url: string | null } | null;
  growth_accounts: { handle: string | null } | null;
}

export async function loadAccountHealth(
  workspaceId: string,
  nowIso = new Date().toISOString(),
): Promise<AccountHealthView> {
  const supabase = createSupabaseServerClient();

  const { data: historyData } = await supabase
    .from("publish_history")
    .select(
      "id, platform, account_id, finished_at, execution_items(title, body, link_url), growth_accounts(handle)",
    )
    .eq("workspace_id", workspaceId)
    .eq("outcome", "published")
    .order("finished_at", { ascending: false })
    .limit(200);

  const rows = (historyData ?? []) as unknown as Row[];
  if (rows.length === 0) return { platforms: [], empty: true };

  const { data: metricRows } = await supabase
    .from("post_metrics")
    .select("publish_history_id, source, status, metrics, fetched_at")
    .eq("workspace_id", workspaceId)
    .in(
      "publish_history_id",
      rows.map((r) => r.id),
    );

  const metrics = new Map<
    string,
    { metrics: VerifiedMetrics; status: string; fetchedAt: string | null }
  >();
  for (const m of (metricRows ?? []) as unknown as Array<{
    publish_history_id: string;
    source: string;
    status: string;
    metrics: Record<string, unknown>;
    fetched_at: string | null;
  }>) {
    if (m.source.startsWith("snapshot:")) continue;
    metrics.set(m.publish_history_id, {
      metrics: m.metrics as VerifiedMetrics,
      status: m.status,
      fetchedAt: m.fetched_at,
    });
  }

  const { data: snapshotRows } = await supabase
    .from("account_snapshots")
    .select(
      "account_id, platform, handle, provider_account_id, followers, following, post_count, provider_created_at, fetched_at, source",
    )
    .eq("workspace_id", workspaceId)
    .order("fetched_at", { ascending: false })
    .limit(200);

  const snapshots = new Map<string, AccountSnapshot>();
  for (const s of (snapshotRows ?? []) as unknown as Array<Record<string, unknown>>) {
    const key = String(s.account_id);
    if (snapshots.has(key)) continue;
    snapshots.set(key, {
      platform: String(s.platform),
      handle: (s.handle as string) ?? "",
      providerAccountId: (s.provider_account_id as string) ?? null,
      followers: (s.followers as number) ?? null,
      following: (s.following as number) ?? null,
      postCount: (s.post_count as number) ?? null,
      createdAt: (s.provider_created_at as string) ?? null,
      fetchedAt: (s.fetched_at as string) ?? nowIso,
      source: (s.source as string) ?? "unknown",
    });
  }

  const platforms = Array.from(new Set(rows.map((r) => r.platform))).sort();

  const views: PlatformHealthView[] = platforms.map((platform) => {
    const platformRows = rows.filter((r) => r.platform === platform);
    const otherRows = rows.filter((r) => r.platform !== platform);
    const accountId = platformRows[0]?.account_id ?? null;

    const toPost = (r: Row) => ({
      id: r.id,
      platform: r.platform,
      publishedAt: r.finished_at,
      title: r.execution_items?.title ?? null,
      body: r.execution_items?.body ?? "",
      linkUrl: r.execution_items?.link_url ?? null,
    });

    const engagementOf = (r: Row): number | null => {
      const cached = metrics.get(r.id);
      if (!cached || cached.status !== "connected") return null;
      return engagementCount(cached.metrics);
    };

    const newestFetchedAt = platformRows
      .map((r) => metrics.get(r.id)?.fetchedAt ?? null)
      .filter((v): v is string => v != null)
      .sort()
      .at(-1) ?? null;

    const freshness: Freshness | null = newestFetchedAt
      ? classifyFreshness({
          fetchedAtIso: newestFetchedAt,
          nowIso,
          status: "connected",
        })
      : null;

    const panel = buildAccountHealthPanel({
      platform,
      handle: platformRows[0]?.growth_accounts?.handle ?? null,
      nowIso,
      account: accountId ? (snapshots.get(accountId) ?? null) : null,
      // Oldest → newest for the cadence and trend series.
      posts: [...platformRows].reverse().map(toPost),
      otherPlatformPosts: otherRows.map(toPost),
      engagementSeries: [...platformRows]
        .reverse()
        .map(engagementOf)
        .filter((v): v is number => v != null),
      metricsFreshness: freshness,
      metricsAgeHours: readingAgeHours(newestFetchedAt, nowIso),
    });

    return {
      panel,
      recommendations: recommendNextActions(panel),
      publishedCount: platformRows.length,
      measuredCount: platformRows.filter((r) => engagementOf(r) != null).length,
      lastPublishedAt: platformRows[0]?.finished_at ?? null,
    };
  });

  return { platforms: views, empty: false };
}
