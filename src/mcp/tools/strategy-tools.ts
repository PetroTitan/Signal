import "server-only";
/**
 * MCP read tools for content strategy.
 *
 * These answer "what should I post next, and on what evidence?" without
 * opening a dashboard — and they answer it the same way the dashboard
 * does, because both call the same loader. There is no second engine
 * here and no tool-specific interpretation.
 *
 * READ-ONLY, and structurally so: none writes a row, none contacts a
 * provider, and none returns anything an agent could mistake for an
 * instruction. Every option carries `blocking: false`, and an invariant
 * test asserts these tools never emit an approval, a schedule, or a
 * publish.
 *
 * `loadStrategy` receives ctx.db — the service-role client, which
 * bypasses RLS — so every query inside it filters on ctx.workspaceId
 * explicitly. The workspace-isolation test covers these tools.
 */

import type { ToolContext } from "../tool-context";
import { failed, ok, type McpToolResponse } from "../responses";
import { loadStrategy, type StrategyView } from "@/core/strategy/load-strategy.server";
import { EVIDENCE_THRESHOLDS } from "@/core/strategy/performance";

/** Warnings every strategy tool carries, so no caller has to infer them. */
function standardWarnings(view: StrategyView): string[] {
  const warnings = [
    "These are options, not instructions. Nothing here blocks publishing, approval, or scheduling.",
    "Observations are descriptive. None of them establishes that a content choice caused a result.",
  ];
  if (view.performance.measuredCount === 0) {
    warnings.push(
      "No post has been measured, so no option below is supported by performance data.",
    );
  } else if (view.performance.level !== "stronger") {
    warnings.push(
      `Performance evidence is below the ${EVIDENCE_THRESHOLDS.verdictRequires}-post gate, so comparisons are descriptive only.`,
    );
  }
  if (view.window.usedFullHistory && !view.empty) {
    warnings.push(view.window.reason);
  }
  return warnings;
}

async function view(ctx: ToolContext): Promise<StrategyView> {
  return loadStrategy(ctx.workspaceId, new Date().toISOString(), { db: ctx.db });
}

/** The whole picture in one call: mix, topics, evidence level, gaps. */
export async function strategySummary(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.strategy.summary";
  try {
    const v = await view(ctx);
    return ok({
      tool,
      summary: v.empty
        ? "Nothing has been published yet, so there is no content strategy to describe."
        : `${v.postCount} post(s) over ${v.window.label} across ${v.platforms.join(", ")}. ${v.mix.summary}`,
      data: {
        empty: v.empty,
        window: v.window,
        postCount: v.postCount,
        platforms: v.platforms,
        publishingRatePerWeek: v.cadence.postsPerWeek,
        daysSinceLastPost: v.cadence.daysSinceLastPost,
        mixSummary: v.mix.summary,
        topicSummary: v.topicSummary,
        dormantTopics: v.dormantTopics,
        dominant: v.dominant,
        untested: v.untested,
        performance: {
          level: v.performance.level,
          measuredCount: v.performance.measuredCount,
          unmeasuredCount: v.performance.unmeasuredCount,
          summary: v.performance.summary,
        },
        differentiationSummary: v.differentiation.summary,
        experimentSummary: v.experimentSummary,
      },
      warnings: standardWarnings(v),
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** What to post next — as options with their evidence, never a directive. */
export async function strategyRecommendations(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.strategy.recommendations";
  try {
    const v = await view(ctx);
    return ok({
      tool,
      summary:
        v.recommendations.length === 0
          ? "No option can be supported by the evidence available."
          : `${v.recommendations.length} option(s), each with the evidence behind it. The operator chooses.`,
      data: {
        options: v.recommendations.map((option) => ({
          id: option.id,
          kind: option.kind,
          title: option.title,
          rationale: option.rationale,
          confidence: option.confidence,
          platform: option.platform,
          suggestedArchetype: option.suggestedArchetype,
          suggestedHook: option.suggestedHook,
          suggestedCta: option.suggestedCta,
          suggestedTopic: option.suggestedTopic,
          experimentIntent: option.experimentIntent,
          evidence: option.evidence,
          blocking: option.blocking,
        })),
      },
      warnings: standardWarnings(v),
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** What has actually been published, by archetype, hook, CTA and format. */
export async function strategyContentMix(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.strategy.content_mix";
  try {
    const v = await view(ctx);
    return ok({
      tool,
      summary: v.mix.summary,
      data: {
        window: v.window,
        total: v.mix.total,
        usesPercentages: v.mix.archetypes.usesPercentages,
        archetypes: v.mix.archetypes,
        hooks: v.mix.hooks,
        ctas: v.mix.ctas,
        topics: v.mix.topics,
        binary: v.mix.binary,
        byPlatform: v.mix.byPlatform,
        untested: v.untested,
        dominant: v.dominant,
        performanceByArchetype: v.performance.byArchetype,
        performanceByHook: v.performance.byHook,
        performanceByCta: v.performance.byCta,
      },
      warnings: [
        ...standardWarnings(v),
        ...(v.mix.total > 0 && !v.mix.archetypes.usesPercentages
          ? ["Counts rather than percentages: the sample is too small for a percentage to mean anything."]
          : []),
      ],
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** How much the same message is reused across platforms. */
export async function strategyCrossPlatform(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.strategy.cross_platform";
  try {
    const v = await view(ctx);
    return ok({
      tool,
      summary: v.differentiation.summary,
      data: {
        platformsCompared: v.differentiation.platformsCompared,
        maxMessagePercent: v.differentiation.maxMessagePercent,
        maxWithinPlatformPercent: v.differentiation.maxWithinPlatformPercent,
        nearSynchronousPairs: v.differentiation.nearSynchronousPairs,
        pairs: v.differentiation.similarPairs.map((pair) => ({
          aId: pair.aId,
          bId: pair.bId,
          platforms: pair.platforms,
          publishedAtA: pair.publishedAtA,
          publishedAtB: pair.publishedAtB,
          minutesApart: pair.minutesApart,
          messagePercent: pair.messagePercent,
          verbatimPercent: pair.verbatimPercent,
          exactDuplicate: pair.exactDuplicate,
          same: pair.same,
          different: pair.different,
          band: pair.band,
          suggestion: pair.suggestion,
        })),
        observations: v.differentiation.observations,
      },
      warnings: [
        "Similarity is a text measurement, not a judgement. Reposting the same message across platforms is a valid choice.",
        "No similarity level blocks publishing, and none is reported to any platform.",
      ],
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}

/** Questions worth asking, with the arithmetic of answering them. */
export async function strategyExperiments(ctx: ToolContext): Promise<McpToolResponse> {
  const tool = "signal.strategy.experiments";
  try {
    const v = await view(ctx);
    return ok({
      tool,
      summary: v.experimentSummary,
      data: {
        publishingRatePerWeek: v.cadence.postsPerWeek,
        postsPerArmForMedian: EVIDENCE_THRESHOLDS.medianRequires,
        postsPerArmForVerdict: EVIDENCE_THRESHOLDS.verdictRequires,
        experiments: v.experiments,
      },
      warnings: [
        ...standardWarnings(v),
        "An experiment here is a question, not a commitment. Nothing enforces the arms and no post is rejected for being outside one.",
      ],
    });
  } catch (err) {
    return failed({ tool, summary: err instanceof Error ? err.message : "unavailable" });
  }
}
