import "server-only";
/**
 * MCP read tools for social performance intelligence.
 *
 * READ-ONLY, all of them. None writes a row, none touches a provider
 * write endpoint, and none can trigger a publish. They answer the
 * questions the milestone set out to make answerable:
 *
 *   what did we publish?          signal.social.recent_posts
 *   how did it perform?           signal.social.performance
 *   how large is the audience?    signal.social.account_health
 *   is the copy too repetitive?   signal.social.repetition
 *   what should happen next?      signal.social.recommend_next_action
 *
 * WORKSPACE ISOLATION: the dispatcher hands every handler a SERVICE-ROLE
 * client, so RLS does not apply inside a tool. Isolation is enforced only
 * by each query carrying `.eq("workspace_id", ctx.workspaceId)`. That was
 * a convention with nothing enforcing it; this milestone adds a test that
 * inspects these handlers' source for the guard.
 *
 * Every answer carries its own sample size and its own caveats, because
 * an agent reading these results will otherwise state them as facts.
 */

import type { ToolContext } from "../tool-context";
import { failed, ok, type McpToolResponse } from "../responses";
import {
  analyzeCadenceByPlatform,
  analyzeRepetition,
  buildAccountHealthPanel,
  recommendNextActions,
  summarizeSample,
  type CadencePost,
  type RepetitionPost,
} from "@/core/intelligence";
import { engagementCount, type VerifiedMetrics } from "@/core/metrics/metrics-provider";
import { availableMetrics, resolveMetricCell } from "@/core/metrics/metric-availability";
import { classifyFreshness, readingAgeHours } from "@/core/metrics/freshness";
import { publicationMethodLabel } from "@/core/publishing/publication-method";

const MAX_POSTS = 200;

interface LoadedPost {
  publishHistoryId: string;
  platform: string;
  accountId: string | null;
  handle: string | null;
  publishedAt: string;
  mode: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  providerPostId: string | null;
  permalink: string | null;
  metrics: VerifiedMetrics | null;
  metricsStatus: string | null;
  metricsFetchedAt: string | null;
  metricsFreshnessRaw: string | null;
  ageWindow: string | null;
}

/**
 * One workspace-scoped load shared by every tool here, so the guard
 * lives in one place and the tools cannot drift apart on filtering.
 */
async function loadPosts(
  ctx: ToolContext,
  platform?: string,
): Promise<{ ok: true; posts: LoadedPost[] } | { ok: false; error: string }> {
  let query = ctx.db
    .from("publish_history")
    .select(
      "id, platform, account_id, mode, finished_at, provider_post_id, provider_permalink, " +
        "execution_items(title, body, link_url), growth_accounts(handle)",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("outcome", "published")
    .order("finished_at", { ascending: false })
    .limit(MAX_POSTS);
  if (platform) query = query.eq("platform", platform);

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    platform: string;
    account_id: string | null;
    mode: string;
    finished_at: string;
    provider_post_id: string | null;
    provider_permalink: string | null;
    execution_items: { title: string | null; body: string | null; link_url: string | null } | null;
    growth_accounts: { handle: string | null } | null;
  }>;

  const metricsById = new Map<
    string,
    { metrics: VerifiedMetrics; status: string; fetchedAt: string | null; freshness: string | null; ageWindow: string | null }
  >();
  if (rows.length > 0) {
    const { data: metricRows, error: metricErr } = await ctx.db
      .from("post_metrics")
      .select("publish_history_id, source, status, metrics, fetched_at, freshness, age_window")
      .eq("workspace_id", ctx.workspaceId)
      .in(
        "publish_history_id",
        rows.map((r) => r.id),
      );
    if (metricErr) return { ok: false, error: metricErr.message };
    for (const m of (metricRows ?? []) as unknown as Array<{
      publish_history_id: string;
      source: string;
      status: string;
      metrics: Record<string, unknown>;
      fetched_at: string | null;
      freshness: string | null;
      age_window: string | null;
    }>) {
      // Skip history snapshots — the canonical row is the latest state.
      if (m.source.startsWith("snapshot:")) continue;
      metricsById.set(m.publish_history_id, {
        metrics: m.metrics as VerifiedMetrics,
        status: m.status,
        fetchedAt: m.fetched_at,
        freshness: m.freshness,
        ageWindow: m.age_window,
      });
    }
  }

  return {
    ok: true,
    posts: rows.map((r) => {
      const cached = metricsById.get(r.id);
      return {
        publishHistoryId: r.id,
        platform: r.platform,
        accountId: r.account_id,
        handle: r.growth_accounts?.handle ?? null,
        publishedAt: r.finished_at,
        mode: r.mode,
        title: r.execution_items?.title ?? null,
        body: r.execution_items?.body ?? "",
        linkUrl: r.execution_items?.link_url ?? null,
        providerPostId: r.provider_post_id,
        permalink: r.provider_permalink,
        metrics: cached?.metrics ?? null,
        metricsStatus: cached?.status ?? null,
        metricsFetchedAt: cached?.fetchedAt ?? null,
        metricsFreshnessRaw: cached?.freshness ?? null,
        ageWindow: cached?.ageWindow ?? null,
      };
    }),
  };
}

/** Engagement, or null when the post has not been measured. */
function engagementOf(post: LoadedPost): number | null {
  if (post.metricsStatus !== "connected" || !post.metrics) return null;
  return engagementCount(post.metrics);
}

// =====================================================================
// signal.social.recent_posts — what did we publish?
// =====================================================================

export async function socialRecentPosts(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.social.recent_posts";
  const loaded = await loadPosts(ctx);
  if (!loaded.ok) return failed({ tool, summary: loaded.error });

  const posts = loaded.posts.map((p) => ({
    publishHistoryId: p.publishHistoryId,
    platform: p.platform,
    handle: p.handle,
    publishedAt: p.publishedAt,
    publicationMethod: p.mode,
    publicationMethodLabel: publicationMethodLabel(p.mode),
    permalink: p.permalink,
    measured: p.metricsStatus === "connected",
    engagement: engagementOf(p),
  }));

  return ok({
    tool,
    summary: `${posts.length} published post(s) across ${new Set(posts.map((p) => p.platform)).size} platform(s)`,
    data: { posts },
    warnings:
      posts.length === MAX_POSTS
        ? [`Result capped at ${MAX_POSTS} posts.`]
        : undefined,
  });
}

// =====================================================================
// signal.social.performance — how did it perform?
// =====================================================================

export async function socialPerformance(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.social.performance";
  const loaded = await loadPosts(ctx);
  if (!loaded.ok) return failed({ tool, summary: loaded.error });

  const nowIso = new Date().toISOString();
  const byPlatform = new Map<string, LoadedPost[]>();
  for (const p of loaded.posts) {
    byPlatform.set(p.platform, [...(byPlatform.get(p.platform) ?? []), p]);
  }

  const platforms = Array.from(byPlatform.keys())
    .sort()
    .map((platform) => {
      const posts = byPlatform.get(platform)!;
      const measured = posts.filter((p) => engagementOf(p) != null);
      const sample = summarizeSample(measured.map((p) => engagementOf(p)!));

      return {
        platform,
        publishedPosts: posts.length,
        measuredPosts: measured.length,
        // Per-metric availability, so an agent never reads a missing
        // metric as a zero.
        metricsReported: availableMetrics(platform),
        impressionsAvailable: availableMetrics(platform).includes("impressions"),
        sample: {
          n: sample.n,
          verdict: sample.verdict,
          median: sample.median,
          p25: sample.p25,
          p75: sample.p75,
        },
        warnings: sample.warnings,
        freshness: posts
          .slice(0, 1)
          .map((p) =>
            classifyFreshness({
              fetchedAtIso: p.metricsFetchedAt,
              nowIso,
              status: (p.metricsStatus as "connected") ?? "pending",
            }),
          )[0] ?? "unavailable",
        oldestMeasurementAgeHours: readingAgeHours(
          measured[measured.length - 1]?.metricsFetchedAt ?? null,
          nowIso,
        ),
      };
    });

  const totalMeasured = platforms.reduce((s, p) => s + p.measuredPosts, 0);
  return ok({
    tool,
    summary:
      totalMeasured === 0
        ? "No post has been measured yet — run the metrics backfill first."
        : `${totalMeasured} measured post(s) across ${platforms.length} platform(s)`,
    data: { platforms },
    warnings: [
      "Medians only. Arithmetic means are not used for social engagement.",
      "A metric absent for a platform is unavailable, not zero.",
    ],
  });
}

// =====================================================================
// signal.social.account_health — audience and signals
// =====================================================================

export async function socialAccountHealth(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.social.account_health";
  const loaded = await loadPosts(ctx);
  if (!loaded.ok) return failed({ tool, summary: loaded.error });

  const { data: snapshots, error: snapErr } = await ctx.db
    .from("account_snapshots")
    .select("account_id, platform, handle, followers, following, post_count, provider_created_at, fetched_at, source, freshness")
    .eq("workspace_id", ctx.workspaceId)
    .order("fetched_at", { ascending: false })
    .limit(200);
  if (snapErr) return failed({ tool, summary: snapErr.message });

  const latestByAccount = new Map<string, Record<string, unknown>>();
  for (const s of (snapshots ?? []) as unknown as Array<Record<string, unknown>>) {
    const key = String(s.account_id);
    if (!latestByAccount.has(key)) latestByAccount.set(key, s);
  }

  const nowIso = new Date().toISOString();
  const platforms = Array.from(new Set(loaded.posts.map((p) => p.platform))).sort();

  const panels = platforms.map((platform) => {
    const platformPosts = loaded.posts.filter((p) => p.platform === platform);
    const others = loaded.posts.filter((p) => p.platform !== platform);
    const accountId = platformPosts[0]?.accountId ?? null;
    const snap = accountId ? latestByAccount.get(accountId) : undefined;

    const asRepetition = (p: LoadedPost): CadencePost & RepetitionPost => ({
      id: p.publishHistoryId,
      platform: p.platform,
      publishedAt: p.publishedAt,
      title: p.title,
      body: p.body,
      linkUrl: p.linkUrl,
    });

    return buildAccountHealthPanel({
      platform,
      handle: platformPosts[0]?.handle ?? null,
      nowIso,
      account: snap
        ? {
            platform,
            handle: (snap.handle as string) ?? "",
            providerAccountId: (snap.provider_account_id as string) ?? null,
            followers: (snap.followers as number) ?? null,
            following: (snap.following as number) ?? null,
            postCount: (snap.post_count as number) ?? null,
            createdAt: (snap.provider_created_at as string) ?? null,
            fetchedAt: (snap.fetched_at as string) ?? nowIso,
            source: (snap.source as string) ?? "unknown",
          }
        : null,
      posts: [...platformPosts].reverse().map(asRepetition),
      otherPlatformPosts: others.map(asRepetition),
      engagementSeries: [...platformPosts]
        .reverse()
        .map(engagementOf)
        .filter((v): v is number => v != null),
      metricsFreshness: platformPosts[0]?.metricsFetchedAt
        ? classifyFreshness({
            fetchedAtIso: platformPosts[0].metricsFetchedAt,
            nowIso,
            status: (platformPosts[0].metricsStatus as "connected") ?? "pending",
          })
        : null,
      metricsAgeHours: readingAgeHours(platformPosts[0]?.metricsFetchedAt ?? null, nowIso),
    });
  });

  return ok({
    tool,
    summary:
      panels.length === 0
        ? "No published posts, so there is nothing to assess."
        : panels.map((p) => `${p.platform}: ${p.summary}`).join(" "),
    data: { panels },
    warnings: [
      "This is an explainable panel, not a score. Each signal carries its own confidence.",
      "No signal here shows that a provider treated the account in any particular way.",
    ],
  });
}

// =====================================================================
// signal.social.repetition — is the copy too repetitive?
// =====================================================================

export async function socialRepetition(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.social.repetition";
  const loaded = await loadPosts(ctx);
  if (!loaded.ok) return failed({ tool, summary: loaded.error });

  const report = analyzeRepetition(
    loaded.posts.map((p) => ({
      id: p.publishHistoryId,
      platform: p.platform,
      publishedAt: p.publishedAt,
      title: p.title,
      body: p.body,
      linkUrl: p.linkUrl,
    })),
  );

  return ok({
    tool,
    summary: report.summary,
    data: {
      postsAnalyzed: report.postsAnalyzed,
      pairsCompared: report.pairsCompared,
      maxCrossPlatformPercent: report.maxCrossPlatformPercent,
      maxWithinPlatformPercent: report.maxWithinPlatformPercent,
      findings: report.findings,
    },
    warnings: [
      "This is Signal's own text-similarity heuristic. It does not reflect any provider's classification.",
    ],
  });
}

// =====================================================================
// signal.social.recommend_next_action
// =====================================================================

export async function socialRecommendNextAction(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const tool = "signal.social.recommend_next_action";
  const health = await socialAccountHealth(ctx);
  if (!health.ok) return health;

  const panels = (health.data as { panels?: Array<Parameters<typeof recommendNextActions>[0]> })
    ?.panels;
  if (!panels || panels.length === 0) {
    return ok({
      tool,
      summary: "Nothing has been published, so there is no recommendation to make.",
      data: { recommendations: [] },
    });
  }

  const recommendations = panels.flatMap((panel) =>
    recommendNextActions(panel).map((r) => ({ platform: panel.platform, ...r })),
  );

  return ok({
    tool,
    summary: recommendations.map((r) => `${r.platform}: ${r.action}`).join(" "),
    data: { recommendations },
    warnings: [
      "Every recommendation is for a person to carry out. Signal does not like, follow, reply or engage on your behalf.",
    ],
  });
}

// =====================================================================
// cadence, exposed separately because it answers a distinct question
// =====================================================================

export async function socialCadence(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.social.cadence";
  const loaded = await loadPosts(ctx);
  if (!loaded.ok) return failed({ tool, summary: loaded.error });

  const signals = analyzeCadenceByPlatform(
    loaded.posts.map((p) => ({
      id: p.publishHistoryId,
      platform: p.platform,
      publishedAt: p.publishedAt,
    })),
    new Date().toISOString(),
  );

  return ok({
    tool,
    summary:
      signals.length === 0
        ? "No published posts."
        : signals.map((s) => `${s.platform}: ${s.state}`).join(", "),
    data: { platforms: signals },
    warnings: [
      "Signal has no evidence for an optimal posting rate on these accounts and does not prescribe one.",
    ],
  });
}

/** Re-exported for the isolation test's benefit. */
export const SOCIAL_INTELLIGENCE_HANDLERS = {
  socialRecentPosts,
  socialPerformance,
  socialAccountHealth,
  socialRepetition,
  socialRecommendNextAction,
  socialCadence,
} as const;

/** Kept referenced so the metric-cell helper stays part of this module's
 *  contract for future per-metric rendering in tool output. */
export const __metricCellHelper = resolveMetricCell;
