/**
 * "What should I post next?" (PURE).
 *
 * Returns OPTIONS — three to five of them — never an instruction. There
 * is no code path here that produces a single command, and none that
 * produces a blocker: `StrategyOption` has no `blocking`, `required` or
 * `severity` field, by construction.
 *
 * DEGRADES, NEVER DISAPPEARS
 * --------------------------
 * Recommendation strength falls with evidence; the recommendation does
 * not vanish. `insufficient_data` means "no statistical performance
 * claim", never "no advice":
 *
 *   nothing published    -> cold-start options, each framed as learning
 *   posts, no metrics    -> observations about the corpus + experiments
 *   small metric sample  -> the same, plus a described comparison
 *   adequate sample      -> the same, plus a permitted verdict
 *
 * EXPLORE VS EXPLOIT
 * ------------------
 * Every set contains at least one EXPLORE option whenever an untested
 * dimension exists. Without that rule the engine becomes a
 * self-reinforcing loop recommending whatever won in a sample of four,
 * and the operator's feed narrows until only one thing is left to
 * recommend. An invariant test asserts the explore option is present.
 *
 * Pure module — no I/O, no clock, no LLM.
 */

import type { Archetype, CtaType, HookType } from "./classifiers";
import { ARCHETYPE_LABELS, CTA_LABELS, HOOK_LABELS } from "./classifiers";
import type { ContentMix, UntestedDimension } from "./content-mix";
import { dominantDimensions, untestedDimensions } from "./content-mix";
import type { DifferentiationReport } from "./differentiation";
import type { TopicModel } from "./topics";
import { dormantTopics } from "./topics";
import {
  NO_PERFORMANCE_DATA_CAVEAT,
  SMALL_SAMPLE_CAVEAT,
  type Confidence,
  type EvidenceItem,
  fact,
  observation,
} from "./evidence";

export type OptionKind =
  | "explore"
  | "exploit"
  | "differentiate"
  | "resume"
  | "cold_start";

export interface StrategyOption {
  id: string;
  kind: OptionKind;
  title: string;
  /** One line the operator can act on. */
  rationale: string;
  /** The facts and observations behind it. Never empty. */
  evidence: EvidenceItem[];
  confidence: Confidence;
  platform: string | null;
  accountId: string | null;
  suggestedArchetype: Archetype | null;
  suggestedHook: HookType | null;
  suggestedCta: CtaType | null;
  suggestedTopic: string | null;
  /** What this option would teach, when its purpose is to learn. */
  experimentIntent: string | null;
  /**
   * Always false. Present as a structural guarantee so no consumer can
   * mistake an option for a requirement.
   */
  blocking: false;
}

export interface RecommendationInput {
  mix: ContentMix;
  topics: TopicModel;
  differentiation: DifferentiationReport;
  /** Days since the last publication, per platform. */
  daysSinceLastPost: Record<string, number>;
  platforms: readonly string[];
  accountId: string | null;
  nowIso: string;
  /** Present only once metrics exist. See performance.ts. */
  performance?: {
    /** Dimensions with a reportable median, best first. */
    strongest: Array<{ dimension: string; value: string; label: string; n: number; median: number }>;
    /** True when any comparison cleared the verdict gate. */
    verdictPermitted: boolean;
    sampleSize: number;
  } | null;
}

export const MIN_OPTIONS = 3;
export const MAX_OPTIONS = 5;

export function recommendWhatToPostNext(
  input: RecommendationInput,
): StrategyOption[] {
  const options: StrategyOption[] = [];

  // ---- cold start ----------------------------------------------------
  if (input.mix.total === 0) {
    return coldStartOptions(input);
  }

  // ---- differentiate (only when a real pair exists) -------------------
  const topPair = input.differentiation.similarPairs[0];
  if (topPair) {
    const [, secondPlatform] = topPair.platforms;
    options.push({
      id: "differentiate",
      kind: "differentiate",
      title: `Give ${secondPlatform} its own version`,
      rationale:
        topPair.suggestion ??
        `Your ${topPair.platforms.join(" and ")} versions share ${topPair.messagePercent}% of their wording.`,
      evidence: [
        fact(
          `Two posts share ${topPair.messagePercent}% of their wording across ${topPair.platforms.join(" and ")}` +
            (topPair.minutesApart != null ? `, published ${topPair.minutesApart} minutes apart.` : "."),
          "Signal's own text comparison",
        ),
        ...(topPair.same.length > 0
          ? [observation(`Shared: ${topPair.same.join(", ")}.`, "Signal's own text comparison")]
          : []),
        ...(topPair.different.length > 0
          ? [observation(`Different: ${topPair.different.join(", ")}.`, "Signal's own text comparison")]
          : []),
      ],
      confidence: topPair.band === "verbatim" ? "strong" : "moderate",
      platform: secondPlatform,
      accountId: input.accountId,
      suggestedArchetype: null,
      suggestedHook: null,
      suggestedCta: null,
      suggestedTopic: null,
      experimentIntent:
        "Whether a platform-native version reads differently to that audience.",
      blocking: false,
    });
  }

  // ---- resume (inactivity) --------------------------------------------
  const dormantPlatform = Object.entries(input.daysSinceLastPost)
    .filter(([, days]) => days >= 14)
    .sort(([, a], [, b]) => b - a)[0];
  if (dormantPlatform) {
    const [platform, days] = dormantPlatform;
    options.push({
      id: `resume-${platform}`,
      kind: "resume",
      title: `Post something on ${platform}`,
      rationale: `Nothing has gone out on ${platform} for ${Math.round(days)} days.`,
      evidence: [
        fact(`${Math.round(days)} days since the last ${platform} publication.`, "publish_history"),
      ],
      confidence: "strong",
      platform,
      accountId: input.accountId,
      suggestedArchetype: null,
      suggestedHook: null,
      suggestedCta: null,
      suggestedTopic: null,
      experimentIntent: null,
      blocking: false,
    });
  }

  // ---- explore (untested dimensions) ----------------------------------
  const untested = untestedDimensions(input.mix);
  for (const dimension of untested.slice(0, 2)) {
    options.push(exploreOption(dimension, input));
  }

  // ---- explore (dormant topic) ----------------------------------------
  const dormant = dormantTopics(input.topics, input.nowIso, 30)[0];
  if (dormant) {
    options.push({
      id: `topic-${dormant.key}`,
      kind: "explore",
      title: `Return to "${dormant.label}"`,
      rationale: `You wrote ${dormant.postCount} posts about this and have not returned to it.`,
      evidence: [
        fact(
          `${dormant.postCount} post(s) on "${dormant.label}", most recently ${dormant.lastPublishedAt.slice(0, 10)}.`,
          "Signal's topic grouping",
        ),
      ],
      confidence: "weak",
      platform: null,
      accountId: input.accountId,
      suggestedArchetype: null,
      suggestedHook: null,
      suggestedCta: null,
      suggestedTopic: dormant.key,
      experimentIntent: "Whether an older theme still resonates.",
      blocking: false,
    });
  }

  // ---- exploit (only with real evidence) -------------------------------
  const strongest = input.performance?.strongest?.[0];
  if (strongest) {
    options.push({
      id: `exploit-${strongest.dimension}-${strongest.value}`,
      kind: "exploit",
      title: `More ${strongest.label.toLowerCase()}`,
      rationale: input.performance?.verdictPermitted
        ? `${strongest.label} posts have the highest median engagement in your measured history.`
        : `${strongest.label} posts recorded the highest median engagement in a small sample.`,
      evidence: [
        fact(
          `${strongest.label}: median ${strongest.median} across ${strongest.n} measured post(s).`,
          "post_metrics",
        ),
        ...(input.performance?.verdictPermitted
          ? []
          : [observation(SMALL_SAMPLE_CAVEAT, "sample-size gate")]),
      ],
      confidence: input.performance?.verdictPermitted ? "moderate" : "weak",
      platform: null,
      accountId: input.accountId,
      suggestedArchetype: null,
      suggestedHook: null,
      suggestedCta: null,
      suggestedTopic: null,
      experimentIntent: null,
      blocking: false,
    });
  }

  // ---- vary a dominant dimension --------------------------------------
  const dominant = dominantDimensions(input.mix)[0];
  if (dominant && options.length < MAX_OPTIONS) {
    options.push({
      id: "vary-dominant",
      kind: "explore",
      title: "Vary the shape of the next post",
      rationale: dominant,
      evidence: [
        fact(dominant, "Signal's content classification"),
        observation(
          input.performance ? SMALL_SAMPLE_CAVEAT : NO_PERFORMANCE_DATA_CAVEAT,
          "post_metrics",
        ),
      ],
      confidence: "weak",
      platform: null,
      accountId: input.accountId,
      suggestedArchetype: null,
      suggestedHook: null,
      suggestedCta: null,
      suggestedTopic: null,
      experimentIntent: "Whether a different shape changes how the post is received.",
      blocking: false,
    });
  }

  return balance(options, input);
}

/**
 * Ensure the returned set is useful and not self-reinforcing.
 *
 * Guarantees, in order: at least one explore option when an untested
 * dimension exists; between MIN and MAX options; and a deterministic
 * order so the same input always produces the same advice.
 */
function balance(
  options: readonly StrategyOption[],
  input: RecommendationInput,
): StrategyOption[] {
  const out = [...options];

  const hasExplore = out.some((o) => o.kind === "explore" || o.kind === "cold_start");
  if (!hasExplore) {
    const untested = untestedDimensions(input.mix)[0];
    if (untested) {
      out.push(exploreOption(untested, input));
    } else {
      out.push(genericExplore(input));
    }
  }

  while (out.length < MIN_OPTIONS) {
    const filler = genericExplore(input, out.length);
    if (out.some((o) => o.id === filler.id)) break;
    out.push(filler);
  }

  return out
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id))
    .slice(0, MAX_OPTIONS);
}

const KIND_RANK: Record<OptionKind, number> = {
  differentiate: 0,
  resume: 1,
  exploit: 2,
  explore: 3,
  cold_start: 4,
};

function exploreOption(
  dimension: UntestedDimension,
  input: RecommendationInput,
): StrategyOption {
  const suggestion = SUGGESTION_FOR_DIMENSION[`${dimension.dimension}:${dimension.value}`];
  return {
    id: `explore-${dimension.dimension}-${dimension.value}`,
    kind: "explore",
    title: `Test ${dimension.label.toLowerCase()}`,
    rationale: `${dimension.fact} There is no evidence either way, which is the reason to try it.`,
    evidence: [
      fact(dimension.fact, "Signal's content classification"),
      observation(
        input.performance ? SMALL_SAMPLE_CAVEAT : NO_PERFORMANCE_DATA_CAVEAT,
        "post_metrics",
      ),
    ],
    confidence: "weak",
    platform: null,
    accountId: input.accountId,
    suggestedArchetype: suggestion?.archetype ?? null,
    suggestedHook: suggestion?.hook ?? null,
    suggestedCta: suggestion?.cta ?? null,
    suggestedTopic: null,
    experimentIntent: `Whether ${dimension.label.toLowerCase()} produces a different response.`,
    blocking: false,
  };
}

const SUGGESTION_FOR_DIMENSION: Record<
  string,
  { archetype?: Archetype; hook?: HookType; cta?: CtaType }
> = {
  "hook:question": { hook: "question", archetype: "question" },
  "cta:ask_question": { cta: "ask_question" },
  "cta:any": { cta: "ask_question" },
  "format:link": { cta: "visit_link" },
  "format:creative": {},
  "voice:second_person": {},
  "archetype:question": { archetype: "question", hook: "question", cta: "ask_question" },
  "archetype:personal_story": { archetype: "personal_story", hook: "story" },
  "archetype:case_study": { archetype: "case_study" },
  "archetype:data_insight": { archetype: "data_insight", hook: "statistic" },
  "archetype:educational": { archetype: "educational" },
};

function genericExplore(input: RecommendationInput, seed = 0): StrategyOption {
  const ideas: Array<{ id: string; title: string; rationale: string; archetype: Archetype; hook: HookType }> = [
    {
      id: "generic-question",
      title: "Ask the audience something",
      rationale: "A question is the cheapest way to find out what this audience cares about.",
      archetype: "question",
      hook: "question",
    },
    {
      id: "generic-story",
      title: "Tell one specific story",
      rationale: "A concrete account of something that happened reads differently to a general principle.",
      archetype: "personal_story",
      hook: "story",
    },
    {
      id: "generic-data",
      title: "Share one number",
      rationale: "A single real figure gives the reader something to react to.",
      archetype: "data_insight",
      hook: "statistic",
    },
  ];
  const idea = ideas[seed % ideas.length];
  return {
    id: idea.id,
    kind: "explore",
    title: idea.title,
    rationale: idea.rationale,
    evidence: [
      observation(
        input.mix.total === 0
          ? "Nothing has been published yet, so there is nothing to compare against."
          : NO_PERFORMANCE_DATA_CAVEAT,
        "post_metrics",
      ),
    ],
    confidence: "weak",
    platform: null,
    accountId: input.accountId,
    suggestedArchetype: idea.archetype,
    suggestedHook: idea.hook,
    suggestedCta: null,
    suggestedTopic: null,
    experimentIntent: "What this audience responds to at all.",
    blocking: false,
  };
}

/**
 * Cold start: nothing published.
 *
 * The product must be useful here, so this returns real options framed
 * as learning rather than an empty state. Every one says plainly that
 * there is no evidence yet.
 */
export function coldStartOptions(input: RecommendationInput): StrategyOption[] {
  const platform = input.platforms[0] ?? null;
  const shapes: Array<{ id: string; title: string; archetype: Archetype; hook: HookType; cta: CtaType; why: string }> = [
    {
      id: "cold-educational",
      title: "Explain one thing you know well",
      archetype: "educational",
      hook: "statement",
      cta: "none",
      why: "Teaching something specific is the easiest post to write and the easiest to judge.",
    },
    {
      id: "cold-question",
      title: "Ask one open question",
      archetype: "question",
      hook: "question",
      cta: "ask_question",
      why: "A question tells you who is listening, which no other format does.",
    },
    {
      id: "cold-story",
      title: "Describe something that actually happened",
      archetype: "personal_story",
      hook: "story",
      cta: "none",
      why: "A concrete account gives the audience a reason to remember the account.",
    },
    {
      id: "cold-opinion",
      title: "State a view you would defend",
      archetype: "founder_opinion",
      hook: "contrarian",
      cta: "none",
      why: "An opinion attracts a different response to an explanation.",
    },
  ];

  return shapes.slice(0, MAX_OPTIONS).map((shape) => ({
    id: shape.id,
    kind: "cold_start" as const,
    title: shape.title,
    rationale: shape.why,
    evidence: [
      fact("Nothing has been published through Signal yet.", "publish_history"),
      observation(
        "With no history, these are starting points rather than findings. Publishing a few different kinds is what gives Signal something to compare.",
        "cold start",
      ),
    ],
    confidence: "none" as const,
    platform,
    accountId: input.accountId,
    suggestedArchetype: shape.archetype,
    suggestedHook: shape.hook,
    suggestedCta: shape.cta,
    suggestedTopic: null,
    experimentIntent: "What this audience responds to at all.",
    blocking: false as const,
  }));
}

/** Human-readable label for an option's suggested shape. */
export function describeSuggestedShape(option: StrategyOption): string {
  const parts: string[] = [];
  if (option.suggestedArchetype) parts.push(ARCHETYPE_LABELS[option.suggestedArchetype]);
  if (option.suggestedHook) parts.push(`${HOOK_LABELS[option.suggestedHook].toLowerCase()} opening`);
  if (option.suggestedCta && option.suggestedCta !== "none") {
    parts.push(CTA_LABELS[option.suggestedCta].toLowerCase());
  }
  if (option.suggestedTopic) parts.push(`about "${option.suggestedTopic}"`);
  return parts.join(" · ");
}
