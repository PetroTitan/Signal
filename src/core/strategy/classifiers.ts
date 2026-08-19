/**
 * Archetype, hook and CTA classification (PURE).
 *
 * Every classifier returns `{ value, confidence, evidence[] }`. A bare
 * label is not acceptable output — the operator has to be able to
 * disagree, and nobody can disagree with a single word.
 *
 * WHY THESE ARE STRUCTURAL, NOT KEYWORD-BASED
 * -------------------------------------------
 * Signal already has a keyword classifier, `classifyTopic`. It was run
 * over the 28 real short-form posts and returned `operational_observation`
 * for 26 of them — which is its DEFAULT when no signature scores at all.
 * It is silent on 93% of this corpus, because its signatures were tuned
 * for platform-affinity warnings on engineering and promo writing, which
 * this operator does not produce.
 *
 * So `classifyTopic` is consulted for what it genuinely detects
 * (promotional, launch, engineering, discussion) and the spine is built
 * on STRUCTURE, which the corpus profile shows is strongly
 * discriminating:
 *
 *   contrarian "X is not Y" opening    7 / 28
 *   list rhythm                        6 / 28
 *   names the product                  4 / 28
 *   second person                      3 / 28
 *   opens with a question              0 / 28
 *   any CTA                            0 / 28
 *
 * UNKNOWN IS A REAL ANSWER. When nothing scores, the value is `unknown`
 * with confidence `none`. Silently defaulting to a plausible label is
 * the specific failure this module exists to avoid.
 */

import { classifyTopic } from "@/core/publishing-qa/topic-matrix";
import type { ContentStrategyFeatures } from "./content-features";
import {
  classified,
  confidenceFromSignals,
  unknownClassification,
  type Classified,
} from "./evidence";

// =====================================================================
// Archetypes
// =====================================================================

export const ARCHETYPES = [
  "educational",
  "product_update",
  "founder_opinion",
  "industry_commentary",
  "announcement",
  "question",
  "case_study",
  "tutorial",
  "data_insight",
  "personal_story",
  "community",
  "promotional",
  "other",
  "unknown",
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  educational: "Educational",
  product_update: "Product update",
  founder_opinion: "Founder opinion",
  industry_commentary: "Industry commentary",
  announcement: "Announcement",
  question: "Question",
  case_study: "Case study",
  tutorial: "Tutorial",
  data_insight: "Data insight",
  personal_story: "Personal story",
  community: "Community",
  promotional: "Promotional",
  other: "Other",
  unknown: "Unclassified",
};

interface Signal {
  archetype: Archetype;
  /** Why it fired, in operator language. */
  reason: string;
}

/**
 * Classify a post's archetype from structure plus the existing topic
 * classifier, returning the evidence for the decision.
 *
 * `productNames` lets the caller supply the workspace's own product
 * names, so "names the product" is a real signal rather than a guess.
 */
export function classifyArchetype(
  features: ContentStrategyFeatures,
  body: string,
  options: { productNames?: readonly string[] } = {},
): Classified<Archetype> {
  const signals: Signal[] = [];
  const text = body.toLowerCase();
  const opening = features.openingSentence.toLowerCase();

  // --- announcement -------------------------------------------------
  if (/^\d+\s+\w/.test(features.openingSentence)) {
    signals.push({ archetype: "announcement", reason: "Opens with a count." });
  }
  if (/\b(now (live|available)|launched|shipped|released|introducing|out now|is live)\b/.test(text)) {
    signals.push({ archetype: "announcement", reason: "Contains launch or release language." });
  }

  // --- product update -----------------------------------------------
  const named = (options.productNames ?? []).filter((n) =>
    n.trim().length > 2 && text.includes(n.toLowerCase()),
  );
  if (named.length > 0) {
    signals.push({
      archetype: "product_update",
      reason: `Names the product (${named[0]}).`,
    });
  }
  if (/\b(new feature|we (added|shipped|built)|update|changelog|improvement)\b/.test(text)) {
    signals.push({ archetype: "product_update", reason: "Describes a change to the product." });
  }

  // --- question -----------------------------------------------------
  if (features.opensWithQuestion) {
    signals.push({ archetype: "question", reason: "Opens with a question." });
  }
  if (features.closesWithQuestion) {
    signals.push({ archetype: "question", reason: "Closes with a question, inviting a reply." });
  }

  // --- personal story -----------------------------------------------
  if (features.usesFirstPerson && /\b(i|we)\s+(learned|realised|realized|spent|tried|failed|built|shipped)\b/.test(text)) {
    signals.push({ archetype: "personal_story", reason: "First-person narrative of something the author did." });
  }

  // --- data insight ---------------------------------------------------
  if (/\b\d+(\.\d+)?%/.test(body) || /\b\d{2,}\b.*\b(posts?|users?|customers?|requests?)\b/.test(text)) {
    signals.push({ archetype: "data_insight", reason: "Contains a figure presented as evidence." });
  }

  // --- tutorial / educational ------------------------------------------
  if (/\b(step \d|first,|second,|third,|how to|here is how|start by)\b/.test(text)) {
    signals.push({ archetype: "tutorial", reason: "Contains sequenced instructions." });
  }
  if (features.hasListRhythm && features.usesSecondPerson) {
    signals.push({ archetype: "educational", reason: "Enumerated points addressed to the reader." });
  }

  // --- opinion vs commentary -------------------------------------------
  // The distinction that matters on this corpus: an impersonal
  // declarative claim is commentary; a first-person one is opinion.
  const contrarian = /\b(is|are|does|do)\s+not\b/.test(opening) || /\bnot\b/.test(opening);
  if (contrarian && features.usesFirstPerson) {
    signals.push({ archetype: "founder_opinion", reason: "First-person contrarian claim." });
  } else if (contrarian) {
    signals.push({
      archetype: "industry_commentary",
      reason: 'Opens with a contrarian claim ("X is not Y").',
    });
  }

  // --- community --------------------------------------------------------
  if (features.mentionCount > 0) {
    signals.push({ archetype: "community", reason: "Mentions another account." });
  }

  // --- the existing keyword classifier, for what it genuinely detects ---
  const topicKind = classifyTopic(body);
  const mapped = TOPIC_KIND_TO_ARCHETYPE[topicKind];
  if (mapped) {
    signals.push({
      archetype: mapped,
      reason: `Signal's topic classifier matched "${topicKind}".`,
    });
  }

  if (signals.length === 0) {
    // Last resort, and deliberately WEAK. An impersonal declarative
    // claim with no product, question or narrative signal is
    // professional commentary — that is what it is, and saying so with
    // stated weak evidence is more useful than "unclassified", which
    // would leave 46% of this corpus outside every mix view.
    //
    // This is not the silent confident default the milestone forbids:
    // the confidence is weak and the reason is shown.
    if (
      !features.usesFirstPerson &&
      !features.usesSecondPerson &&
      features.openingSentence.length > 0
    ) {
      return classified("industry_commentary", "weak", [
        "Impersonal declarative claim with no product, question, narrative or instructional signal.",
      ]);
    }
    return unknownClassification<Archetype>(
      "unknown",
      "No structural or keyword signal distinguished this post.",
    );
  }

  // Winner = most supporting signals; ties break by declaration order in
  // ARCHETYPES, which is stable and inspectable.
  const counts = new Map<Archetype, Signal[]>();
  for (const s of signals) {
    counts.set(s.archetype, [...(counts.get(s.archetype) ?? []), s]);
  }
  const ranked = Array.from(counts.entries()).sort(
    ([aKind, aSignals], [bKind, bSignals]) =>
      bSignals.length - aSignals.length ||
      ARCHETYPES.indexOf(aKind) - ARCHETYPES.indexOf(bKind),
  );
  const [winner, winnerSignals] = ranked[0];

  return classified(
    winner,
    confidenceFromSignals(winnerSignals.length),
    winnerSignals.map((s) => s.reason),
  );
}

/**
 * Only the TopicKinds that carry a genuine archetype meaning are mapped.
 * `operational_observation` is deliberately ABSENT: it is the
 * classifier's no-match default, so mapping it would turn "nothing
 * matched" into a confident archetype on 93% of this corpus.
 */
const TOPIC_KIND_TO_ARCHETYPE: Partial<Record<string, Archetype>> = {
  promotional: "promotional",
  launch_announcement: "announcement",
  changelog: "product_update",
  discussion_question: "question",
  engineering_article: "educational",
  architecture_deep_dive: "educational",
  long_form_explainer: "educational",
  operator_lesson: "case_study",
  founder_observation: "founder_opinion",
  industry_summary: "industry_commentary",
  reflective_commentary: "industry_commentary",
  visual_storytelling: "personal_story",
};

// =====================================================================
// Hooks
// =====================================================================

export const HOOK_TYPES = [
  "statement",
  "question",
  "contrarian",
  "observation",
  "statistic",
  "announcement",
  "problem",
  "story",
  "advice",
  "product_led",
  "unknown",
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export const HOOK_LABELS: Record<HookType, string> = {
  statement: "Declarative statement",
  question: "Question",
  contrarian: "Contrarian claim",
  observation: "Observation",
  statistic: "Statistic or figure",
  announcement: "Announcement",
  problem: "Problem statement",
  story: "Story opening",
  advice: "Direct advice",
  product_led: "Product-led",
  unknown: "Unclassified",
};

/**
 * Classify the OPENING of a post.
 *
 * Order matters: the more specific patterns are tested first, so a
 * contrarian opening is not flattened into a plain statement. Everything
 * ending in a full stop would be a "statement", which would be true and
 * useless — 25 of 28 real posts would land there.
 */
export function classifyHook(
  features: ContentStrategyFeatures,
  options: { productNames?: readonly string[] } = {},
): Classified<HookType> {
  const opening = features.openingSentence;
  if (!opening.trim()) {
    return unknownClassification<HookType>("unknown", "The post has no opening sentence.");
  }
  const lower = opening.toLowerCase();

  if (features.opensWithQuestion) {
    return classified("question", "strong", ["The opening sentence is a question."]);
  }
  if (/^\d/.test(opening) || /\b\d+(\.\d+)?%/.test(opening)) {
    return classified("statistic", "strong", ["The opening leads with a figure."]);
  }
  if (/\b(now live|launched|shipped|released|introducing|out now|is live)\b/.test(lower)) {
    return classified("announcement", "strong", ["The opening announces something."]);
  }
  if (/^(do not|don't|never|always|stop|start|before|first|map|measure|ship|name|collect|write|try|use)\b/.test(lower)) {
    return classified("advice", "moderate", ["The opening is an instruction to the reader."]);
  }
  if (/\b(is|are|does|do|was|were)\s+not\b/.test(lower) || /\bnot\s+\w+\b/.test(lower)) {
    return classified("contrarian", "moderate", [
      'The opening denies a common belief ("X is not Y").',
    ]);
  }
  if (/\b(fails?|breaks?|problem|struggle|hard|difficult|cannot|can't|wrong)\b/.test(lower)) {
    return classified("problem", "moderate", ["The opening names a problem."]);
  }
  if (/^(i|we)\b/.test(lower) || /\b(last (week|month|year)|when i|when we|a few years ago)\b/.test(lower)) {
    return classified("story", "moderate", ["The opening begins a personal account."]);
  }
  const named = (options.productNames ?? []).find(
    (n) => n.trim().length > 2 && lower.includes(n.toLowerCase()),
  );
  if (named) {
    return classified("product_led", "moderate", [`The opening leads with the product (${named}).`]);
  }
  if (/\b(most|many|some|often|usually|still|traditionally|these days)\b/.test(lower)) {
    return classified("observation", "weak", [
      "The opening generalises about how things usually are.",
    ]);
  }
  return classified("statement", "weak", [
    "The opening is a plain declarative sentence with no more specific pattern.",
  ]);
}

// =====================================================================
// CTAs
// =====================================================================

export const CTA_TYPES = [
  "none",
  "ask_question",
  "visit_link",
  "try_product",
  "reply",
  "share",
  "follow",
  "learn_more",
  "download",
  "contact",
  "other",
] as const;
export type CtaType = (typeof CTA_TYPES)[number];

export const CTA_LABELS: Record<CtaType, string> = {
  none: "No call to action",
  ask_question: "Asks a question",
  visit_link: "Visit a link",
  try_product: "Try the product",
  reply: "Invite a reply",
  share: "Ask for a share",
  follow: "Ask for a follow",
  learn_more: "Learn more",
  download: "Download",
  contact: "Get in touch",
  other: "Other",
};

/**
 * Classify the call to action, looking at the CLOSING of the post.
 *
 * On the real corpus this returns `none` for every post — there are zero
 * CTAs across 61 publications. That is a genuine, useful finding, and it
 * is why `none` is a first-class value here rather than a fallback.
 */
export function classifyCta(
  features: ContentStrategyFeatures,
  body: string,
): Classified<CtaType> {
  // The last two lines: a CTA that is not near the end is not a CTA.
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tailRaw = lines.slice(-2).join(" ");
  const tail = tailRaw.toLowerCase();
  const evidence: string[] = [];

  /**
   * A CTA is DIRECTED AT THE READER.
   *
   * "People search for the function, find the app, install it." contains
   * "install" but describes what users do — it asks nothing of anyone.
   * So an action phrase only counts when it opens a sentence in the tail
   * (imperative) or the tail addresses the reader as "you".
   */
  const sentences = tailRaw.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const directed = (phrases: readonly string[]): boolean => {
    const present = phrases.some((phrase) => tail.includes(phrase));
    if (!present) return false;
    if (/\b(you|your)\b/i.test(tailRaw)) return true;
    return sentences.some((sentence) =>
      phrases.some((phrase) => sentence.toLowerCase().startsWith(phrase)),
    );
  };

  if (features.closesWithQuestion) {
    return classified("ask_question", "strong", [
      "The post ends with a question, which invites an answer.",
    ]);
  }
  if (/\b(reply|comment below|let me know|tell me|what do you think|thoughts\?)\b/.test(tail)) {
    return classified("reply", "strong", ["The closing asks for a reply."]);
  }
  if (directed(["try it", "try ", "sign up", "get started", "start free", "use it"])) {
    return classified("try_product", "moderate", ["The closing invites the reader to try something."]);
  }
  if (directed(["download", "install", "grab it"])) {
    return classified("download", "moderate", ["The closing asks for a download."]);
  }
  if (directed(["follow", "subscribe"])) {
    return classified("follow", "moderate", ["The closing asks for a follow."]);
  }
  if (directed(["share", "repost", "retweet", "pass it on"])) {
    return classified("share", "moderate", ["The closing asks for a share."]);
  }
  if (directed(["read more", "learn more", "full post", "details here", "more here"])) {
    return classified("learn_more", "moderate", ["The closing points to more reading."]);
  }
  if (directed(["email", "contact", "get in touch", "dm me", "message me"])) {
    return classified("contact", "moderate", ["The closing invites contact."]);
  }
  if (features.hasLink) {
    evidence.push("The post carries a link but the closing does not ask the reader to open it.");
    return classified("visit_link", "weak", evidence);
  }

  return classified("none", "strong", [
    "The closing makes a statement rather than asking the reader to do anything.",
  ]);
}
