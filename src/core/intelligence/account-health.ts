/**
 * Account health as an EXPLAINABLE PANEL, not a score (PURE).
 *
 * A single opaque number would be the wrong shape for this product twice
 * over. It would compress signals of wildly different confidence into
 * one figure — audience size is a hard fact from the provider, recent
 * performance is four data points — and it would invite exactly the
 * causal reading the evidence cannot support. So every signal stands on
 * its own with its evidence, its timeframe, its source and its state.
 *
 * There is deliberately no `overallScore` field. If one is ever wanted,
 * it should be argued for on its own merits rather than arriving as a
 * side effect of this module.
 *
 * LANGUAGE
 * --------
 * No signal is ever labelled "dead", "shadowbanned", "spammy" or
 * "failing". An account with one follower is not a bad account; it is an
 * account whose reach cannot yet be measured, and the copy says that.
 * A test scans every emitted string.
 *
 * Pure module — no I/O, no clock (`nowIso` is passed in).
 */

import { classifyTopic } from "@/core/publishing-qa/topic-matrix";
import {
  audienceBand,
  audienceSupportsPerformanceAnalysis,
  describeAudience,
  type AccountSnapshot,
} from "@/core/metrics/account-context";
import { describeFreshness, type Freshness } from "@/core/metrics/freshness";
import { supportsImpressions } from "@/core/metrics/metric-availability";
import { platformLabel } from "@/core/metrics/metric-availability";
import { analyzeCadence, type CadencePost, type CadenceSignal } from "./cadence";
import { analyzeRepetition, type RepetitionPost } from "./repetition";
import { classifyTrend, summarizeSample } from "./statistics";

export type SignalState =
  | "normal"
  | "advisory"
  | "insufficient_data"
  | "unavailable"
  | "stale"
  | "rate_limited"
  | "provider_error";

export type SignalKey =
  | "audience"
  | "cadence"
  | "inactivity"
  | "cross_platform_similarity"
  | "promotional_pressure"
  | "link_frequency"
  | "recent_performance"
  | "data_freshness"
  | "interaction_visibility";

export interface HealthSignal {
  key: SignalKey;
  label: string;
  state: SignalState;
  /** The headline figure, when there is one. Null is a real answer. */
  value: string | null;
  /** What supports the value — numbers and dates, not adjectives. */
  evidence: string;
  /** The period the evidence covers. */
  timeframe: string;
  /** Where the underlying data came from. */
  source: string;
  /** How much weight the signal can bear. */
  confidence: "high" | "medium" | "low" | "none";
}

export interface AccountHealthPanel {
  platform: string;
  handle: string | null;
  signals: HealthSignal[];
  /** One sentence describing what can and cannot be said. No score. */
  summary: string;
}

export interface HealthInput {
  platform: string;
  handle: string | null;
  nowIso: string;
  /** Provider account snapshot, when one has been read. */
  account: AccountSnapshot | null;
  /** Everything published on this platform, oldest → newest. */
  posts: readonly (CadencePost & RepetitionPost)[];
  /** Posts on OTHER platforms, for cross-platform comparison. */
  otherPlatformPosts: readonly RepetitionPost[];
  /** Engagement per measured post, oldest → newest. */
  engagementSeries: readonly number[];
  /** Freshness of the most recent metric read. */
  metricsFreshness: Freshness | null;
  /** Age of that read, in hours. */
  metricsAgeHours: number | null;
}

export function buildAccountHealthPanel(input: HealthInput): AccountHealthPanel {
  const cadence = analyzeCadence(input.posts, input.platform, input.nowIso);
  const signals: HealthSignal[] = [
    audienceSignal(input),
    cadenceSignal(input, cadence),
    inactivitySignal(input, cadence),
    crossPlatformSignal(input),
    promotionalSignal(input),
    linkSignal(input),
    performanceSignal(input),
    freshnessSignal(input),
    interactionSignal(input),
  ];

  return {
    platform: input.platform,
    handle: input.handle,
    signals,
    summary: summarise(input, signals),
  };
}

// ---------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------

function audienceSignal(input: HealthInput): HealthSignal {
  const followers = input.account?.followers ?? null;
  const base = {
    key: "audience" as const,
    label: "Audience",
    timeframe: "current",
    source: input.account?.source ?? "not read",
  };
  if (followers == null) {
    return {
      ...base,
      state: "unavailable",
      value: null,
      evidence:
        "Follower count has not been read, so nothing else on this panel can be put in context.",
      confidence: "none",
    };
  }
  const band = audienceBand(followers);
  return {
    ...base,
    // An account with no audience is not "abnormal" — it is early. The
    // advisory state means "read the rest of this panel with care".
    state: band === "no_audience" || band === "minimal_audience" ? "advisory" : "normal",
    value: `${followers} follower${followers === 1 ? "" : "s"}`,
    evidence: describeAudience({ platform: input.platform, followers }),
    confidence: "high",
  };
}

function cadenceSignal(input: HealthInput, cadence: CadenceSignal): HealthSignal {
  const base = {
    key: "cadence" as const,
    label: "Posting cadence",
    timeframe: "all recorded publications",
    source: "publish_history",
  };
  if (cadence.medianIntervalHours == null) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: `${cadence.totalPosts} recorded post${cadence.totalPosts === 1 ? "" : "s"} — too few to describe a rhythm.`,
      confidence: "none",
    };
  }
  return {
    ...base,
    state: cadence.bursts.length > 0 ? "advisory" : "normal",
    value: `${cadence.postsLast7d} in the last 7 days`,
    evidence: cadence.observations.join(" "),
    confidence: cadence.totalPosts >= 10 ? "medium" : "low",
  };
}

function inactivitySignal(input: HealthInput, cadence: CadenceSignal): HealthSignal {
  const base = {
    key: "inactivity" as const,
    label: "Recent activity",
    timeframe: "since the last publication",
    source: "publish_history",
  };
  if (cadence.daysSinceLastPost == null) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: `Nothing has been published to ${platformLabel(input.platform)} through Signal.`,
      confidence: "none",
    };
  }
  const days = Math.round(cadence.daysSinceLastPost);
  return {
    ...base,
    state: cadence.state === "active" ? "normal" : "advisory",
    value: `${days} day${days === 1 ? "" : "s"} since the last post`,
    evidence:
      cadence.state === "dormant"
        ? `No post for ${days} days. Recent performance figures describe an inactive account, not how any particular post was received.`
        : cadence.state === "paused"
          ? `No post for ${days} days.`
          : `Last published ${days} day${days === 1 ? "" : "s"} ago.`,
    confidence: "high",
  };
}

function crossPlatformSignal(input: HealthInput): HealthSignal {
  const base = {
    key: "cross_platform_similarity" as const,
    label: "Cross-platform similarity",
    timeframe: "all recorded publications",
    source: "Signal's own text analysis",
  };
  if (input.otherPlatformPosts.length === 0 || input.posts.length === 0) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: "Needs posts on at least two platforms to compare.",
      confidence: "none",
    };
  }

  const report = analyzeRepetition([...input.posts, ...input.otherPlatformPosts]);
  const crossFindings = report.findings.filter((f) => f.kind === "cross_platform_copy");
  if (crossFindings.length === 0) {
    return {
      ...base,
      state: "normal",
      value: report.maxCrossPlatformPercent != null ? `${report.maxCrossPlatformPercent}% highest` : null,
      evidence: report.summary,
      confidence: "medium",
    };
  }
  return {
    ...base,
    state: "advisory",
    value: `${report.maxCrossPlatformPercent}% highest`,
    evidence: `${crossFindings[0].evidence}. ${report.summary}`,
    confidence: "medium",
  };
}

/**
 * Promotional pressure, using the EXISTING deterministic classifier
 * rather than a new one or an LLM. `classifyTopic` scores 13 topic kinds
 * from keyword signatures; `promotional` and `launch_announcement` are
 * the two that read as selling.
 */
function promotionalSignal(input: HealthInput): HealthSignal {
  const base = {
    key: "promotional_pressure" as const,
    label: "Promotional share",
    timeframe: "last 20 publications",
    source: "Signal's topic classifier (deterministic)",
  };
  const recent = input.posts.slice(-20);
  if (recent.length < 3) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: `${recent.length} recent post${recent.length === 1 ? "" : "s"} — too few to describe a mix.`,
      confidence: "none",
    };
  }
  const kinds = recent.map((p) => classifyTopic(`${p.title ?? ""}\n${p.body}`));
  const promo = kinds.filter(
    (k) => k === "promotional" || k === "launch_announcement",
  ).length;
  const share = promo / recent.length;
  const streak = longestStreak(kinds, (k) => k === "promotional" || k === "launch_announcement");

  return {
    ...base,
    state: share >= 0.5 || streak >= 3 ? "advisory" : "normal",
    value: `${Math.round(share * 100)}% promotional`,
    evidence:
      `${promo} of the last ${recent.length} posts read as promotional or launch content` +
      (streak >= 2 ? `, with a run of ${streak} in a row` : "") +
      ".",
    confidence: "medium",
  };
}

function linkSignal(input: HealthInput): HealthSignal {
  const base = {
    key: "link_frequency" as const,
    label: "Outbound links",
    timeframe: "last 20 publications",
    source: "publish_history",
  };
  const recent = input.posts.slice(-20);
  if (recent.length === 0) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: "No recorded publications.",
      confidence: "none",
    };
  }
  const withLink = recent.filter((p) => Boolean(p.linkUrl)).length;
  const share = withLink / recent.length;
  return {
    ...base,
    state: share >= 0.8 ? "advisory" : "normal",
    value: `${withLink} of ${recent.length} carry a link`,
    evidence:
      withLink === 0
        ? "None of the recent posts carry an outbound link."
        : `${withLink} of the last ${recent.length} posts carry an outbound link.`,
    confidence: "high",
  };
}

function performanceSignal(input: HealthInput): HealthSignal {
  const base = {
    key: "recent_performance" as const,
    label: "Recent performance",
    timeframe: "measured publications",
    source: "provider metrics",
  };
  const summary = summarizeSample(input.engagementSeries);

  if (summary.n === 0) {
    return {
      ...base,
      state: "insufficient_data",
      value: null,
      evidence: "No post has been measured yet.",
      confidence: "none",
    };
  }
  if (!audienceSupportsPerformanceAnalysis(input.account?.followers ?? null)) {
    return {
      ...base,
      state: "insufficient_data",
      value: summary.median != null ? `median ${summary.median}` : null,
      evidence:
        `${summary.n} measured post${summary.n === 1 ? "" : "s"}. ` +
        "The audience is too small for engagement to carry signal, so no trend is reported.",
      confidence: "none",
    };
  }

  const trend = classifyTrend(input.engagementSeries);
  return {
    ...base,
    state: trend.direction === "insufficient_data" ? "insufficient_data" : "normal",
    value: summary.median != null ? `median ${summary.median}, n=${summary.n}` : null,
    evidence: [trend.summary, ...summary.warnings].join(" "),
    confidence: summary.verdict === "verdict_permitted" ? "medium" : "low",
  };
}

function freshnessSignal(input: HealthInput): HealthSignal {
  const base = {
    key: "data_freshness" as const,
    label: "Data freshness",
    timeframe: "most recent metric read",
    source: "post_metrics",
  };
  if (!input.metricsFreshness) {
    return {
      ...base,
      state: "unavailable",
      value: null,
      evidence: "No metric read has been recorded for this account.",
      confidence: "none",
    };
  }
  const stateMap: Record<Freshness, SignalState> = {
    fresh: "normal",
    stale: "stale",
    unavailable: "unavailable",
    rate_limited: "rate_limited",
    provider_error: "provider_error",
  };
  return {
    ...base,
    state: stateMap[input.metricsFreshness],
    value: input.metricsFreshness,
    evidence: describeFreshness(input.metricsFreshness, input.metricsAgeHours),
    confidence: input.metricsFreshness === "fresh" ? "high" : "low",
  };
}

/**
 * What the provider lets Signal see at all. Stated explicitly so an
 * operator does not read a missing metric as a bad result.
 */
function interactionSignal(input: HealthInput): HealthSignal {
  const hasImpressions = supportsImpressions(input.platform);
  return {
    key: "interaction_visibility",
    label: "What this platform reports",
    state: "normal",
    value: hasImpressions ? "impressions available" : "no impressions",
    evidence: hasImpressions
      ? `${platformLabel(input.platform)} reports impressions alongside likes, replies, reposts, quotes and bookmarks.`
      : `${platformLabel(input.platform)} reports likes, replies, reposts, quotes and bookmarks. It does not expose impressions, views or reach — that is a property of the platform, not a gap in this account's data.`,
    timeframe: "current provider capability",
    source: "provider documentation",
    confidence: "high",
  };
}

// ---------------------------------------------------------------------

function summarise(input: HealthInput, signals: HealthSignal[]): string {
  const advisory = signals.filter((s) => s.state === "advisory");
  const insufficient = signals.filter((s) => s.state === "insufficient_data");
  const label = platformLabel(input.platform);

  const parts: string[] = [];
  if (advisory.length > 0) {
    parts.push(
      `${advisory.length} signal${advisory.length === 1 ? "" : "s"} worth attention on ${label}: ` +
        advisory.map((s) => s.label.toLowerCase()).join(", "),
    );
  } else {
    parts.push(`Nothing on ${label} is flagged for attention`);
  }
  if (insufficient.length > 0) {
    parts.push(
      `${insufficient.length} cannot be assessed yet (${insufficient.map((s) => s.label.toLowerCase()).join(", ")})`,
    );
  }
  return `${parts.join("; ")}.`;
}

function longestStreak<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let best = 0;
  let run = 0;
  for (const item of items) {
    run = predicate(item) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
