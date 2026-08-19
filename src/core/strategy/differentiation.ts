/**
 * Cross-platform differentiation (PURE).
 *
 * REUSES the canonical similarity primitive and the repetition analyser
 * rather than adding a third engine. This module's job is to turn pair
 * findings into a per-pair REPORT an operator can act on — what is the
 * same, what differs, and what a more platform-native version would
 * change.
 *
 * EXTENDED THIS MILESTONE: the previous work measured X↔Bluesky only.
 * The real corpus shows the same message also reaching Telegram, so
 * every platform pair is compared.
 *
 * NOTHING HERE BLOCKS ANYTHING. There is no threshold at which a post
 * becomes unpublishable. 100% identical copy across every platform stays
 * publishable, and an invariant test asserts this module exposes no
 * blocking verdict of any kind.
 *
 * Pure module — no I/O, no clock.
 */

import {
  analyzeRepetition,
  openingHook,
  closingCta,
  paragraphShape,
  rhythmSimilarity,
  type RepetitionPost,
} from "@/core/intelligence/repetition";
import {
  CROSS_PLATFORM_HIGH_THRESHOLD,
  CROSS_PLATFORM_WARN_THRESHOLD,
  asPercent,
  isExactDuplicate,
  messageSimilarity,
  tokenize,
  verbatimSimilarity,
} from "@/core/intelligence/similarity";
import { firstSentence } from "./content-features";
import { observation, type EvidenceItem } from "./evidence";

/** Posts published this close together read as one automated action. */
export const NEAR_SYNCHRONOUS_MINUTES = 30;

export interface DifferentiationInput {
  id: string;
  platform: string;
  publishedAt: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
}

export interface PairDifferentiation {
  aId: string;
  bId: string;
  platforms: [string, string];
  publishedAtA: string;
  publishedAtB: string;
  minutesApart: number | null;
  /** Word-bigram similarity — "the same message, reworded". */
  messagePercent: number;
  /** 5-token shingle similarity — "the same text". */
  verbatimPercent: number;
  exactDuplicate: boolean;
  /** What is shared between the two versions. */
  same: string[];
  /** What genuinely differs. */
  different: string[];
  /** How strongly this reads as one message on two platforms. */
  band: "none" | "warn" | "high" | "verbatim";
  /** Concrete, non-binding suggestion for the second version. */
  suggestion: string | null;
}

export interface DifferentiationReport {
  pairs: PairDifferentiation[];
  /** Pairs at or above the warn threshold, most similar first. */
  similarPairs: PairDifferentiation[];
  maxMessagePercent: number | null;
  /** For contrast: the most similar pair on the SAME platform. */
  maxWithinPlatformPercent: number | null;
  nearSynchronousPairs: number;
  platformsCompared: string[];
  summary: string;
  observations: EvidenceItem[];
}

export function analyzeDifferentiation(
  posts: readonly DifferentiationInput[],
): DifferentiationReport {
  const platforms = Array.from(new Set(posts.map((p) => p.platform))).sort();

  // Delegate the pair scan to the canonical analyser, then enrich the
  // cross-platform findings with a same/different breakdown.
  const repetitionPosts: RepetitionPost[] = posts.map((p) => ({
    id: p.id,
    platform: p.platform,
    publishedAt: p.publishedAt,
    title: p.title,
    body: p.body,
    linkUrl: p.linkUrl,
  }));
  const repetition = analyzeRepetition(repetitionPosts);

  const pairs: PairDifferentiation[] = [];

  for (let i = 0; i < posts.length; i += 1) {
    for (let j = i + 1; j < posts.length; j += 1) {
      const a = posts[i];
      const b = posts[j];
      if (a.platform === b.platform) continue;
      // Empty bodies are not comparable; the similarity primitive now
      // returns 0 for them, and a pair of blanks is not a finding.
      if (!a.body.trim() || !b.body.trim()) continue;

      const message = messageSimilarity(a.body, b.body);
      const verbatim = verbatimSimilarity(a.body, b.body);
      const exact = isExactDuplicate(a.body, b.body);
      const band = bandFor(message, verbatim, exact);
      if (band === "none") continue;

      pairs.push(
        describePair(a, b, { message, verbatim, exact, band }),
      );
    }
  }

  pairs.sort((x, y) => y.messagePercent - x.messagePercent);

  const nearSynchronousPairs = pairs.filter(
    (p) => p.minutesApart != null && p.minutesApart <= NEAR_SYNCHRONOUS_MINUTES,
  ).length;

  const observations: EvidenceItem[] = [];
  if (pairs.length > 0) {
    const top = pairs[0];
    observations.push(
      observation(
        `Your most similar cross-platform pair shares ${top.messagePercent}% of its wording (${top.platforms.join(" and ")})` +
          (top.minutesApart != null ? `, published ${formatGap(top.minutesApart)} apart.` : "."),
        "Signal's own text comparison",
      ),
    );
  }
  if (nearSynchronousPairs > 0) {
    observations.push(
      observation(
        `${nearSynchronousPairs} cross-platform pair(s) went out within ${NEAR_SYNCHRONOUS_MINUTES} minutes of each other.`,
        "publish_history timestamps",
      ),
    );
  }
  if (repetition.maxWithinPlatformPercent != null && repetition.maxCrossPlatformPercent != null) {
    observations.push(
      observation(
        `Across your whole history, the most similar cross-platform pair is ${repetition.maxCrossPlatformPercent}% while the most similar pair on the SAME platform is ${repetition.maxWithinPlatformPercent}%.`,
        "Signal's own text comparison",
      ),
    );
  }

  return {
    pairs,
    similarPairs: pairs.filter((p) => p.band !== "none"),
    maxMessagePercent: repetition.maxCrossPlatformPercent,
    maxWithinPlatformPercent: repetition.maxWithinPlatformPercent,
    nearSynchronousPairs,
    platformsCompared: platforms,
    summary: summarise(pairs, platforms, repetition.maxWithinPlatformPercent),
    observations,
  };
}

function bandFor(
  message: number,
  verbatim: number,
  exact: boolean,
): PairDifferentiation["band"] {
  if (exact) return "verbatim";
  if (verbatim >= 0.45) return "verbatim";
  if (message >= CROSS_PLATFORM_HIGH_THRESHOLD) return "high";
  if (message >= CROSS_PLATFORM_WARN_THRESHOLD) return "warn";
  return "none";
}

function describePair(
  a: DifferentiationInput,
  b: DifferentiationInput,
  scores: { message: number; verbatim: number; exact: boolean; band: PairDifferentiation["band"] },
): PairDifferentiation {
  const same: string[] = [];
  const different: string[] = [];

  // Compare the first SENTENCE, not the first line. `openingHook`
  // returns the first non-empty line, which for a single-paragraph post
  // is the entire body — so "the openings match" would only ever be true
  // for posts that are already identical, and the real 2026-08-15 pair
  // (same opening, one extra closing sentence) would report as having
  // nothing in common at the opening.
  const hookA = firstSentence(openingHook(a.body, a.title));
  const hookB = firstSentence(openingHook(b.body, b.title));
  if (hookA && hookB && normalise(hookA) === normalise(hookB)) same.push("opening line");
  else different.push("opening line");

  const ctaA = closingCta(a.body);
  const ctaB = closingCta(b.body);
  if (ctaA && ctaB && normalise(ctaA) === normalise(ctaB)) same.push("closing line");
  else if (ctaA || ctaB) different.push("closing line");

  const rhythm = rhythmSimilarity(a.body, b.body);
  if (rhythm >= 0.75) same.push("paragraph shape");
  else different.push("paragraph shape");

  if (a.linkUrl && b.linkUrl && a.linkUrl === b.linkUrl) same.push("link");

  if (scores.message >= CROSS_PLATFORM_HIGH_THRESHOLD) same.push("core wording");
  else if (scores.message >= CROSS_PLATFORM_WARN_THRESHOLD) same.push("much of the wording");

  const shapeA = paragraphShape(a.body).length;
  const shapeB = paragraphShape(b.body).length;
  if (shapeA !== shapeB) different.push(`structure (${shapeA} vs ${shapeB} paragraphs)`);

  // Word-count difference catches the common real case: the same post
  // with one extra closing sentence. Both are one paragraph, so the
  // structural check above sees nothing, yet the versions do differ.
  const wordsA = tokenize(a.body).length;
  const wordsB = tokenize(b.body).length;
  const longer = Math.max(wordsA, wordsB);
  if (longer > 0 && Math.abs(wordsA - wordsB) / longer >= 0.05) {
    different.push(`length (${wordsA} vs ${wordsB} words)`);
  }

  const minutesApart = minutesBetween(a.publishedAt, b.publishedAt);

  return {
    aId: a.id,
    bId: b.id,
    platforms: [a.platform, b.platform],
    publishedAtA: a.publishedAt,
    publishedAtB: b.publishedAt,
    minutesApart,
    messagePercent: asPercent(scores.message),
    verbatimPercent: asPercent(scores.verbatim),
    exactDuplicate: scores.exact,
    same,
    different,
    band: scores.band,
    suggestion: suggestFor(b.platform, same, scores.band),
  };
}

/**
 * A concrete, platform-aware suggestion. Never an instruction, and never
 * a claim that the change will improve anything — only that it would
 * make the second version less of a copy.
 */
function suggestFor(
  platform: string,
  same: readonly string[],
  band: PairDifferentiation["band"],
): string | null {
  if (band === "none") return null;
  const shared = same.includes("opening line")
    ? "the opening line"
    : same.includes("core wording")
      ? "the core wording"
      : "much of the wording";

  switch (platform) {
    case "bluesky":
      return `The ${platform} version repeats ${shared}. Consider a more conversational treatment there — Bluesky posts that read as a remark rather than a statement fit the feed better.`;
    case "x":
      return `The ${platform} version repeats ${shared}. Consider a shorter, sharper framing for X.`;
    case "telegram":
      return `The ${platform} version repeats ${shared}. Telegram allows more room — consider expanding it rather than reusing the short-form copy.`;
    default:
      return `The ${platform} version repeats ${shared}. Consider rewriting it for that audience.`;
  }
}

function summarise(
  pairs: readonly PairDifferentiation[],
  platforms: readonly string[],
  maxWithin: number | null,
): string {
  if (platforms.length < 2) {
    return "Only one platform has posts, so there is nothing to compare across platforms.";
  }
  if (pairs.length === 0) {
    return `No cross-platform pair reuses enough wording to report, across ${platforms.join(", ")}.`;
  }
  const contrast =
    maxWithin != null
      ? ` For contrast, the most similar pair on the same platform is ${maxWithin}%.`
      : "";
  return `${pairs.length} cross-platform pair(s) reuse the same message; the closest shares ${pairs[0].messagePercent}% of its wording.${contrast}`;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function minutesBetween(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 60000);
}

function formatGap(minutes: number): string {
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
