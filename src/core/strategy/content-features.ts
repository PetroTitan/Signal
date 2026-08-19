/**
 * Canonical content feature extraction (PURE).
 *
 * ONE deterministic layer that turns a published (or draft) post into the
 * features every strategy analysis reads. Nothing else in this milestone
 * parses post text — if a feature is needed, it is added here.
 *
 * UNKNOWN STAYS UNKNOWN. Every derived field is nullable, and none is
 * populated to satisfy the type. A post whose body is empty produces
 * nulls, not zeroes and not guesses.
 *
 * CALIBRATED ON THE REAL CORPUS. The thresholds and patterns below were
 * profiled against Signal's actual 61 published posts, not invented:
 *
 *   X          avg 191 chars /  29 words / 2.6 paragraphs
 *   Bluesky    avg 230 chars /  34 words / 2.8 paragraphs
 *   Telegram   avg 344 chars /  53 words / 3.6 paragraphs
 *   dev.to     avg 2925 chars / 448 words / 18.8 paragraphs
 *
 * Length varies 15x across platforms, so length bands are per-platform.
 * Comparing a dev.to article to an X post by character count would be
 * measuring the platform, not the writing.
 *
 * Pure module — no I/O, no clock, no LLM.
 */

import { tokenize } from "@/core/intelligence/similarity";
import { openingHook, closingCta } from "@/core/intelligence/repetition";
import type { Classified } from "./evidence";

export interface RawPost {
  id: string;
  platform: string;
  accountId: string | null;
  /** Provider handle, when known. */
  handle: string | null;
  publishedAt: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  /** publish_history.mode. A WEAK hint only — see the note below. */
  mode?: string | null;
  /** True when a creative was attached to the originating plan item. */
  hasCreative?: boolean;
  creativeType?: string | null;
}

export type LengthBand = "very_short" | "short" | "medium" | "long" | "very_long";

/**
 * Per-platform word-count band edges.
 *
 * Derived from the measured corpus: a "short" X post and a "short"
 * dev.to article are wildly different word counts, and one global scale
 * would classify every short-form post as "very_short" and every article
 * as "very_long", carrying no information at all.
 */
const LENGTH_BANDS: Record<string, [number, number, number, number]> = {
  //            very_short<  short<  medium<  long<   (else very_long)
  x: [15, 25, 40, 60],
  bluesky: [18, 30, 45, 70],
  telegram: [25, 45, 70, 110],
  devto: [200, 400, 700, 1200],
  hashnode: [200, 400, 700, 1200],
  reddit: [40, 100, 250, 500],
  linkedin: [40, 90, 180, 350],
};

/** Fallback for a platform with no measured profile. */
const DEFAULT_BANDS: [number, number, number, number] = [25, 60, 150, 400];

export interface ContentStrategyFeatures {
  // ---- identity (measured) ----
  id: string;
  platform: string;
  accountId: string | null;
  handle: string | null;
  publishedAt: string;

  // ---- shape (measured) ----
  bodyLength: number;
  wordCount: number;
  paragraphCount: number;
  lineCount: number;
  lengthBand: LengthBand;

  // ---- presence (measured) ----
  hasTitle: boolean;
  hasLink: boolean;
  linkCount: number;
  hashtagCount: number;
  mentionCount: number;
  hasCreative: boolean | null;
  creativeType: string | null;

  // ---- language shape (derived) ----
  questionCount: number;
  /** A question anywhere in the body. */
  hasQuestion: boolean;
  /** The FIRST sentence is a question. Distinct and much rarer. */
  opensWithQuestion: boolean;
  /**
   * A question in the CLOSING line — the only position where a question
   * reads as an invitation to reply rather than as rhetoric. In the real
   * corpus this is 1 of 28, while "contains a question" is 7 of 28.
   */
  closesWithQuestion: boolean;
  usesSecondPerson: boolean;
  usesFirstPerson: boolean;
  /** Short consecutive lines, the enumerated-list rhythm. */
  hasListRhythm: boolean;

  // ---- structure (derived) ----
  openingSentence: string;
  openingLength: number;
  closingLine: string;
  /** Null when there is only one line — a closing needs something to close. */
  hasDistinctClosing: boolean;

  // ---- provenance (measured, weak) ----
  /**
   * publish_history.mode. Treated as a WEAK hint and never presented as
   * ground truth: six operator-initiated write sites pass no mode and
   * land as 'api' via the repository default, so 'api' does not mean
   * "Signal published this unattended".
   */
  publicationModeHint: string | null;
}

export function extractFeatures(post: RawPost): ContentStrategyFeatures {
  const body = post.body ?? "";
  const lines = body.split(/\r?\n/);
  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);
  const paragraphs = body.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const words = tokenize(body);

  const opening = openingHook(body, null);
  const openingSentence = firstSentence(opening);
  const closing = closingCta(body);

  return {
    id: post.id,
    platform: post.platform,
    accountId: post.accountId,
    handle: post.handle,
    publishedAt: post.publishedAt,

    bodyLength: body.length,
    wordCount: words.length,
    paragraphCount: paragraphs.length,
    lineCount: nonEmptyLines.length,
    lengthBand: classifyLength(post.platform, words.length),

    hasTitle: Boolean(post.title && post.title.trim()),
    hasLink: Boolean(post.linkUrl) || countUrls(body) > 0,
    linkCount: countUrls(body) + (post.linkUrl ? 1 : 0),
    hashtagCount: countMatches(body, /(^|\s)#[A-Za-z][\w-]*/g),
    mentionCount: countMatches(body, /(^|\s)@[A-Za-z][\w.-]*/g),
    hasCreative: post.hasCreative ?? null,
    creativeType: post.creativeType ?? null,

    questionCount: countMatches(body, /\?/g),
    hasQuestion: body.includes("?"),
    opensWithQuestion: openingSentence.trim().endsWith("?"),
    closesWithQuestion: closing.trim().endsWith("?"),
    usesSecondPerson: /\b(you|your|yours|you're|youre)\b/i.test(body),
    usesFirstPerson: /\b(i|i'm|im|my|we|we're|were|our)\b/i.test(body),
    hasListRhythm: nonEmptyLines.filter((l) => l.length > 0 && l.length < 70).length >= 3,

    openingSentence,
    openingLength: openingSentence.length,
    closingLine: closing,
    hasDistinctClosing: closing.length > 0,

    publicationModeHint: post.mode ?? null,
  };
}

/** Word-count band, scaled to the platform. */
export function classifyLength(platform: string, wordCount: number): LengthBand {
  const [a, b, c, d] = LENGTH_BANDS[platform] ?? DEFAULT_BANDS;
  if (wordCount < a) return "very_short";
  if (wordCount < b) return "short";
  if (wordCount < c) return "medium";
  if (wordCount < d) return "long";
  return "very_long";
}

/** The bands in use for a platform, for display and for tests. */
export function lengthBandsFor(platform: string): [number, number, number, number] {
  return LENGTH_BANDS[platform] ?? DEFAULT_BANDS;
}

export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // Split on sentence-ending punctuation followed by whitespace. A bare
  // period inside "dev.to" or "3.5" must not end the sentence, hence the
  // lookahead requiring whitespace.
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed);
  return (match ? match[0] : trimmed).trim();
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function countUrls(text: string): number {
  return countMatches(text, /\bhttps?:\/\/\S+/gi);
}

/**
 * A feature set plus every classification made about it. The classifiers
 * live in their own modules; this is what carries them together.
 */
export interface ClassifiedPost {
  features: ContentStrategyFeatures;
  archetype: Classified<string>;
  hook: Classified<string>;
  cta: Classified<string>;
  topic: Classified<string>;
}

/** Group features by platform, sorted oldest -> newest within each. */
export function groupByPlatform(
  features: readonly ContentStrategyFeatures[],
): Map<string, ContentStrategyFeatures[]> {
  const out = new Map<string, ContentStrategyFeatures[]>();
  for (const f of features) {
    out.set(f.platform, [...(out.get(f.platform) ?? []), f]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  }
  return out;
}

/** The most recent N, newest first. */
export function mostRecent<T extends { publishedAt: string }>(
  items: readonly T[],
  n: number,
): T[] {
  return [...items]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, Math.max(0, n));
}
