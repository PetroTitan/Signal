import "server-only";
/**
 * Assemble the content-strategy surface from the database.
 *
 * Kept out of the page component so the page stays a renderer and the
 * assembly is testable on its own. Every query is workspace-scoped, and
 * this runs under the operator's cookie session, so RLS applies too.
 *
 * THE WINDOW IS HONEST ABOUT ITSELF. A 90-day window over an account
 * that publishes twice a month contains four posts, and four posts
 * cannot carry a content mix. So when the window is too thin the loader
 * falls back to the full history and SAYS which one it used, rather than
 * quietly reporting "your recent mix" from a sample that is mostly
 * absence.
 *
 * Nothing here writes. Nothing here calls a provider.
 */

import { createSupabaseServerClient } from "@/lib/supabase";
import { engagementCount, type VerifiedMetrics } from "@/core/metrics/metrics-provider";
import { analyzeCadence, type CadencePost } from "@/core/intelligence/cadence";
import {
  ARCHETYPES,
  CTA_TYPES,
  HOOK_TYPES,
  classifyArchetype,
  classifyCta,
  classifyHook,
  type Archetype,
  type CtaType,
  type HookType,
} from "./classifiers";
import { extractFeatures, type ContentStrategyFeatures, type RawPost } from "./content-features";
import { buildContentMix, dominantDimensions, untestedDimensions, type ContentMix, type ClassifiedForMix, type UntestedDimension } from "./content-mix";
import { analyzeDifferentiation, type DifferentiationReport } from "./differentiation";
import {
  describeExperiments,
  publishingRate,
  suggestExperiments,
  type ExperimentSuggestion,
} from "./experiments";
import {
  analyzePerformance,
  toRecommendationPerformance,
  type MeasuredPost,
  type PerformanceEvidence,
} from "./performance";
import { recommendWhatToPostNext, type StrategyOption } from "./recommendations";
import {
  buildTopicModel,
  describeTopicModel,
  dormantTopics,
  topicOf,
  MIN_POSTS_FOR_CLUSTERING,
  type TopicModel,
} from "./topics";
import type { Classified } from "./evidence";

/** Default analysis window. Falls back to all history when too thin. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Below this many posts in the window, use the full history instead. */
export const MIN_POSTS_IN_WINDOW = MIN_POSTS_FOR_CLUSTERING;

/** Hard cap on rows read, so the page cost stays bounded. */
const MAX_POSTS = 200;

export interface ClassifiedPost {
  id: string;
  platform: string;
  publishedAt: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  features: ContentStrategyFeatures;
  archetype: Classified<Archetype>;
  hook: Classified<HookType>;
  cta: Classified<CtaType>;
  topic: Classified<string>;
  /** Null when never measured. Never silently zero. */
  engagement: number | null;
  ageWindow: string | null;
}

export interface StrategyView {
  /** True when nothing has been published at all. */
  empty: boolean;
  generatedAt: string;
  /** Which window the numbers describe, and why. */
  window: {
    days: number | null;
    label: string;
    usedFullHistory: boolean;
    reason: string;
  };
  postCount: number;
  platforms: string[];
  posts: ClassifiedPost[];
  mix: ContentMix;
  untested: UntestedDimension[];
  dominant: string[];
  topics: TopicModel;
  topicSummary: string;
  dormantTopics: string[];
  differentiation: DifferentiationReport;
  performance: PerformanceEvidence;
  recommendations: StrategyOption[];
  experiments: ExperimentSuggestion[];
  experimentSummary: string;
  cadence: {
    postsPerWeek: number | null;
    spanDays: number | null;
    daysSinceLastPost: Record<string, number>;
  };
}

interface HistoryRow {
  id: string;
  platform: string;
  account_id: string | null;
  finished_at: string;
  execution_items: {
    title: string | null;
    body: string | null;
    link_url: string | null;
    creative_asset_id?: string | null;
  } | null;
  growth_accounts: { handle: string | null } | null;
}

export async function loadStrategy(
  workspaceId: string,
  nowIso = new Date().toISOString(),
  options: { windowDays?: number } = {},
): Promise<StrategyView> {
  const supabase = createSupabaseServerClient();

  const { data: historyData } = await supabase
    .from("publish_history")
    .select(
      "id, platform, account_id, finished_at, execution_items(title, body, link_url, creative_asset_id), growth_accounts(handle)",
    )
    .eq("workspace_id", workspaceId)
    .eq("outcome", "published")
    .order("finished_at", { ascending: false })
    .limit(MAX_POSTS);

  const allRows = ((historyData ?? []) as unknown as HistoryRow[]).filter(
    (r) => Number.isFinite(Date.parse(r.finished_at)),
  );

  if (allRows.length === 0) return emptyView(nowIso);

  // ---- window selection ------------------------------------------------
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoff = new Date(Date.parse(nowIso) - windowDays * 86_400_000).toISOString();
  const inWindow = allRows.filter((r) => r.finished_at >= cutoff);
  const usedFullHistory = inWindow.length < MIN_POSTS_IN_WINDOW;
  const rows = usedFullHistory ? allRows : inWindow;

  // ---- product names, so "names the product" is a real signal ----------
  const { data: productData } = await supabase
    .from("products")
    .select("name")
    .eq("workspace_id", workspaceId)
    .limit(50);
  const productNames = ((productData ?? []) as Array<{ name: string | null }>)
    .map((p) => p.name)
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);

  // ---- measurements ----------------------------------------------------
  const { data: metricRows } = await supabase
    .from("post_metrics")
    .select("publish_history_id, source, status, metrics, age_window")
    .eq("workspace_id", workspaceId)
    .in(
      "publish_history_id",
      rows.map((r) => r.id),
    );

  const measurements = new Map<string, { engagement: number | null; ageWindow: string | null }>();
  for (const m of (metricRows ?? []) as unknown as Array<{
    publish_history_id: string;
    source: string;
    status: string;
    metrics: Record<string, unknown>;
    age_window: string | null;
  }>) {
    // History snapshots share the table with current readings. Counting
    // both would let one post appear in a sample several times.
    if (String(m.source ?? "").startsWith("snapshot:")) continue;
    if (m.status !== "connected") continue;
    measurements.set(m.publish_history_id, {
      engagement: engagementCount(m.metrics as VerifiedMetrics),
      ageWindow: m.age_window,
    });
  }

  // ---- features and classification -------------------------------------
  const raw: RawPost[] = rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    accountId: r.account_id,
    handle: r.growth_accounts?.handle ?? null,
    publishedAt: r.finished_at,
    title: r.execution_items?.title ?? null,
    body: r.execution_items?.body ?? "",
    linkUrl: r.execution_items?.link_url ?? null,
    hasCreative: r.execution_items
      ? r.execution_items.creative_asset_id != null
      : undefined,
  }));

  const topics = buildTopicModel(
    raw.map((p) => ({
      id: p.id,
      body: p.body,
      title: p.title,
      publishedAt: p.publishedAt,
      platform: p.platform,
    })),
  );

  const posts: ClassifiedPost[] = raw.map((p) => {
    const features = extractFeatures(p);
    const measured = measurements.get(p.id);
    return {
      id: p.id,
      platform: p.platform,
      publishedAt: p.publishedAt,
      title: p.title,
      body: p.body,
      linkUrl: p.linkUrl,
      features,
      archetype: classifyArchetype(features, p.body, { productNames }),
      hook: classifyHook(features, { productNames }),
      cta: classifyCta(features, p.body),
      topic: topicOf(topics, p.id),
      engagement: measured?.engagement ?? null,
      ageWindow: measured?.ageWindow ?? null,
    };
  });

  // ---- mix, differentiation, performance -------------------------------
  // ClassifiedPost is a superset of both consumer shapes, so these are
  // widening reads rather than casts.
  const forMix: ClassifiedForMix[] = posts;
  const mix = buildContentMix(forMix, {
    archetypes: [...ARCHETYPES],
    hooks: [...HOOK_TYPES],
    ctas: [...CTA_TYPES],
    topics: topics.clusters.map((c) => c.key),
  });

  const differentiation = analyzeDifferentiation(
    raw.map((p) => ({
      id: p.id,
      platform: p.platform,
      publishedAt: p.publishedAt,
      title: p.title,
      body: p.body,
      linkUrl: p.linkUrl,
    })),
  );

  const forPerformance: MeasuredPost[] = posts;
  const performance = analyzePerformance(forPerformance);

  // ---- cadence ---------------------------------------------------------
  const cadencePosts: CadencePost[] = raw.map((p) => ({
    id: p.id,
    platform: p.platform,
    publishedAt: p.publishedAt,
  }));
  const platforms = Array.from(new Set(rows.map((r) => r.platform))).sort();

  const daysSinceLastPost: Record<string, number> = {};
  for (const platform of platforms) {
    const signal = analyzeCadence(cadencePosts, platform, nowIso);
    if (signal.daysSinceLastPost != null) {
      daysSinceLastPost[platform] = signal.daysSinceLastPost;
    }
  }

  const { postsPerWeek, spanDays } = publishingRate(raw.map((p) => p.publishedAt), nowIso);

  // ---- recommendations and experiments ---------------------------------
  const recommendations = recommendWhatToPostNext({
    mix,
    topics,
    differentiation,
    daysSinceLastPost,
    platforms,
    accountId: rows[0]?.account_id ?? null,
    nowIso,
    performance: toRecommendationPerformance(performance),
  });

  const experiments = suggestExperiments({ mix, performance, postsPerWeek, nowIso });

  return {
    empty: false,
    generatedAt: nowIso,
    window: {
      days: usedFullHistory ? null : windowDays,
      label: usedFullHistory ? "all history" : `last ${windowDays} days`,
      usedFullHistory,
      reason: usedFullHistory
        ? `Only ${inWindow.length} post(s) fall inside the last ${windowDays} days — fewer than the ${MIN_POSTS_IN_WINDOW} needed to describe a mix, so the whole history is used instead.`
        : `${rows.length} post(s) published in the last ${windowDays} days.`,
    },
    postCount: rows.length,
    platforms,
    posts,
    mix,
    untested: untestedDimensions(mix),
    dominant: dominantDimensions(mix),
    topics,
    topicSummary: describeTopicModel(topics),
    dormantTopics: dormantTopics(topics, nowIso).map((c) => c.label),
    differentiation,
    performance,
    recommendations,
    experiments,
    experimentSummary: describeExperiments(experiments, postsPerWeek),
    cadence: { postsPerWeek, spanDays, daysSinceLastPost },
  };
}


function emptyView(nowIso: string): StrategyView {
  const mix = buildContentMix([], {
    archetypes: [...ARCHETYPES],
    hooks: [...HOOK_TYPES],
    ctas: [...CTA_TYPES],
    topics: [],
  });
  const topics = buildTopicModel([]);
  const differentiation = analyzeDifferentiation([]);
  const performance = analyzePerformance([]);
  return {
    empty: true,
    generatedAt: nowIso,
    window: {
      days: null,
      label: "all history",
      usedFullHistory: true,
      reason: "Nothing has been published yet.",
    },
    postCount: 0,
    platforms: [],
    posts: [],
    mix,
    untested: [],
    dominant: [],
    topics,
    topicSummary: describeTopicModel(topics),
    dormantTopics: [],
    differentiation,
    performance,
    recommendations: recommendWhatToPostNext({
      mix,
      topics,
      differentiation,
      daysSinceLastPost: {},
      platforms: [],
      accountId: null,
      nowIso,
      performance: null,
    }),
    experiments: [],
    experimentSummary: describeExperiments([], null),
    cadence: { postsPerWeek: null, spanDays: null, daysSinceLastPost: {} },
  };
}
