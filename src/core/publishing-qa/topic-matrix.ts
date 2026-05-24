/**
 * Topic ownership matrix.
 *
 * A pure-data table mapping (TopicKind × FounderPlatform) to an
 * affinity level. The orchestrator uses this to either accept the
 * draft, warn that it's off-platform, or block it as forbidden.
 *
 * Classification is keyword-based (no ML). The classifier picks the
 * single best TopicKind by scoring text against keyword lists; ties
 * resolve to the more conservative ("more discouraged") kind so we
 * surface warnings rather than miss them.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { TopicAffinity, TopicKind } from "./types";

// =====================================================================
// The matrix
// =====================================================================
//
// Read top-to-bottom: each row says "this kind of content has this
// affinity on this platform." Discouraged ≠ forbidden — operators
// can still publish, they just get a warning.

export const TOPIC_AFFINITY: Record<TopicKind, Record<FounderPlatform, TopicAffinity>> = {
  operational_observation: {
    x: "native",
    bluesky: "native",
    threads: "derivative",
    instagram: "discouraged",
    linkedin: "derivative",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "derivative",
    indie_hackers: "derivative",
    telegram: "derivative",
    youtube: "discouraged",
  },
  reflective_commentary: {
    x: "derivative",
    bluesky: "native",
    threads: "derivative",
    instagram: "discouraged",
    linkedin: "derivative",
    devto: "discouraged",
    hashnode: "derivative",
    reddit: "derivative",
    indie_hackers: "derivative",
    telegram: "discouraged",
    youtube: "discouraged",
  },
  founder_observation: {
    x: "derivative",
    bluesky: "derivative",
    threads: "native",
    instagram: "discouraged",
    linkedin: "derivative",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "discouraged",
    indie_hackers: "native",
    telegram: "derivative",
    youtube: "discouraged",
  },
  visual_storytelling: {
    x: "discouraged",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "native",
    linkedin: "derivative",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "discouraged",
    indie_hackers: "discouraged",
    telegram: "discouraged",
    youtube: "derivative",
  },
  industry_summary: {
    x: "discouraged",
    bluesky: "derivative",
    threads: "discouraged",
    instagram: "discouraged",
    linkedin: "native",
    devto: "derivative",
    hashnode: "derivative",
    reddit: "discouraged",
    indie_hackers: "derivative",
    telegram: "derivative",
    youtube: "discouraged",
  },
  engineering_article: {
    x: "discouraged",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "forbidden",
    linkedin: "derivative",
    devto: "native",
    hashnode: "native",
    reddit: "derivative",
    indie_hackers: "discouraged",
    telegram: "discouraged",
    youtube: "derivative",
  },
  architecture_deep_dive: {
    x: "discouraged",
    bluesky: "discouraged",
    threads: "forbidden",
    instagram: "forbidden",
    linkedin: "derivative",
    devto: "derivative",
    hashnode: "native",
    reddit: "discouraged",
    indie_hackers: "discouraged",
    telegram: "discouraged",
    youtube: "derivative",
  },
  discussion_question: {
    x: "derivative",
    bluesky: "derivative",
    threads: "derivative",
    instagram: "discouraged",
    linkedin: "discouraged",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "native",
    indie_hackers: "derivative",
    telegram: "discouraged",
    youtube: "discouraged",
  },
  operator_lesson: {
    x: "derivative",
    bluesky: "derivative",
    threads: "derivative",
    instagram: "discouraged",
    linkedin: "derivative",
    devto: "derivative",
    hashnode: "derivative",
    reddit: "derivative",
    indie_hackers: "native",
    telegram: "derivative",
    youtube: "derivative",
  },
  changelog: {
    x: "derivative",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "discouraged",
    linkedin: "discouraged",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "discouraged",
    indie_hackers: "derivative",
    telegram: "native",
    youtube: "discouraged",
  },
  long_form_explainer: {
    x: "discouraged",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "discouraged",
    linkedin: "derivative",
    devto: "derivative",
    hashnode: "derivative",
    reddit: "discouraged",
    indie_hackers: "discouraged",
    telegram: "discouraged",
    youtube: "native",
  },
  launch_announcement: {
    x: "derivative",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "derivative",
    linkedin: "derivative",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "forbidden",
    indie_hackers: "derivative",
    telegram: "native",
    youtube: "discouraged",
  },
  promotional: {
    x: "discouraged",
    bluesky: "discouraged",
    threads: "discouraged",
    instagram: "discouraged",
    linkedin: "discouraged",
    devto: "discouraged",
    hashnode: "discouraged",
    reddit: "forbidden",
    indie_hackers: "discouraged",
    telegram: "discouraged",
    youtube: "discouraged",
  },
};

// =====================================================================
// Keyword-based classifier
// =====================================================================
//
// Each TopicKind has a small, hand-tuned keyword set. The classifier
// scores the draft text against every set, and returns the highest-
// scoring kind. Ties resolve toward the more restrictive kind
// (architecture_deep_dive beats engineering_article; promotional beats
// industry_summary) so we surface warnings instead of missing them.

interface TopicSignature {
  kind: TopicKind;
  /** Lower-case substrings; if any appear, +1 to the score. */
  keywords: ReadonlyArray<string>;
  /** Regex signals; each match also adds 1 to the score. */
  patterns?: ReadonlyArray<RegExp>;
  /** Tiebreaker priority: higher wins ties. */
  priority: number;
}

const SIGNATURES: ReadonlyArray<TopicSignature> = [
  {
    kind: "promotional",
    keywords: [
      "buy now",
      "sign up today",
      "limited time",
      "discount",
      "promo code",
      "save 50%",
      "starting at $",
      "free trial",
      "free for 30 days",
    ],
    priority: 90,
  },
  {
    kind: "launch_announcement",
    keywords: [
      "introducing",
      "today we're launching",
      "today we are launching",
      "now live",
      "now available",
      "general availability",
      "public beta",
      "v1.0 is here",
      "shipped",
    ],
    priority: 85,
  },
  {
    kind: "architecture_deep_dive",
    keywords: [
      "architecture",
      "system design",
      "data model",
      "queue topology",
      "schema design",
      "design rationale",
      "decision record",
      "trade-off between",
      "sharding",
      "consistency model",
    ],
    priority: 80,
  },
  {
    kind: "engineering_article",
    keywords: [
      "step by step",
      "in this article",
      "we'll cover",
      "let's walk through",
      "here's how to",
      "tutorial",
      "code example",
      "npm install",
      "import {",
    ],
    patterns: [/```/, /\bgithub\.com\b/, /\bnext\.js\b/i],
    priority: 70,
  },
  {
    kind: "long_form_explainer",
    keywords: [
      "today we'll explain",
      "explained calmly",
      "the goal of this video",
      "in this video",
      "the shape of",
      "long-form",
    ],
    priority: 65,
  },
  {
    kind: "industry_summary",
    keywords: [
      "across the industry",
      "the state of",
      "in the past quarter",
      "according to",
      "macro trend",
      "the broader ecosystem",
    ],
    priority: 60,
  },
  {
    kind: "operator_lesson",
    keywords: [
      "what we learned",
      "lesson learned",
      "what worked",
      "what didn't",
      "post-mortem",
      "honest update",
      "behind the scenes of",
    ],
    priority: 55,
  },
  {
    kind: "changelog",
    keywords: [
      "changelog",
      "this week we shipped",
      "release notes",
      "patch notes",
      "ship log",
      "build log",
      "deployed:",
    ],
    priority: 50,
  },
  {
    kind: "discussion_question",
    keywords: [
      "open question:",
      "has anyone",
      "curious if",
      "what are folks",
      "how are you handling",
      "looking for input",
    ],
    patterns: [/\?\s*$/],
    priority: 45,
  },
  {
    kind: "reflective_commentary",
    keywords: [
      "the interesting thing",
      "the thing i keep",
      "spent the week",
      "a quiet pattern",
      "worth writing down",
    ],
    priority: 40,
  },
  {
    kind: "founder_observation",
    keywords: [
      "three months in",
      "what surprised us",
      "honest note",
      "next to you at a coffee shop",
      "as a founder",
    ],
    priority: 35,
  },
  {
    kind: "visual_storytelling",
    keywords: [
      "carousel",
      "swipe to see",
      "behind the scenes photo",
      "screenshot of",
      "diagram below",
    ],
    priority: 30,
  },
  {
    kind: "operational_observation",
    keywords: [
      "in the last 30 days",
      "a pattern in",
      "small observation",
      "logbook note",
      "noticed today",
    ],
    priority: 20,
  },
];

export function classifyTopic(draftText: string): TopicKind {
  const text = draftText.toLowerCase();
  let bestKind: TopicKind = "operational_observation";
  let bestScore = 0;
  let bestPriority = -1;
  for (const sig of SIGNATURES) {
    let score = 0;
    for (const kw of sig.keywords) if (text.includes(kw)) score++;
    if (sig.patterns) {
      for (const re of sig.patterns) if (re.test(draftText)) score++;
    }
    if (score === 0) continue;
    if (
      score > bestScore ||
      (score === bestScore && sig.priority > bestPriority)
    ) {
      bestScore = score;
      bestKind = sig.kind;
      bestPriority = sig.priority;
    }
  }
  return bestKind;
}

export function affinityFor(
  topic: TopicKind,
  platform: FounderPlatform,
): TopicAffinity {
  return TOPIC_AFFINITY[topic][platform];
}
