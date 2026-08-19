/**
 * Content repetition intelligence (PURE).
 *
 * This is the one finding in the whole milestone that the existing data
 * already supports. Measured over Signal's real published corpus:
 *
 *   cross-platform (X ↔ Bluesky)  195 pairs, max 83.0% bigram similarity
 *   within X                      105 pairs, max  7.8%
 *   within Bluesky                 78 pairs, max  4.3%
 *
 * Generation is producing genuinely varied copy WITHIN each platform.
 * The repetition is entirely in the cross-platform dimension: the same
 * message reissued to both platforms, in six of seven cases within five
 * minutes. That is a copy-paste automation footprint, it is measurable
 * deterministically, and it is worth fixing.
 *
 * WHAT THIS MODULE MAY AND MAY NOT SAY
 * ------------------------------------
 * It reports what the text and the timestamps show, with the numbers
 * attached: "Cross-platform similarity 83%, published 20 minutes apart."
 * It is Signal's own internal heuristic and nothing more. It must never
 * assert that a provider classified anything as spam, or that repetition
 * caused any performance outcome — no provider exposes that, so any such
 * claim would be invented. A test asserts every emitted string is clean.
 *
 * Pure module — no I/O, no clock, no LLM. Deterministic analysis is
 * sufficient here and is auditable in a way a model is not.
 */

import { hookSimilarity } from "@/core/publishing-qa/near-duplicate";
import {
  CROSS_PLATFORM_HIGH_THRESHOLD,
  CROSS_PLATFORM_WARN_THRESHOLD,
  VERBATIM_THRESHOLD,
  asPercent,
  bandCrossPlatform,
  canonicalize,
  isExactDuplicate,
  jaccard,
  messageSimilarity,
  shingles,
  tokenize,
  verbatimSimilarity,
} from "./similarity";

export interface RepetitionPost {
  id: string;
  platform: string;
  /** ISO instant. */
  publishedAt: string;
  title?: string | null;
  body: string;
  linkUrl?: string | null;
}

export type RepetitionKind =
  | "exact_duplicate"
  | "near_duplicate"
  | "cross_platform_copy"
  | "repeated_opening"
  | "repeated_cta"
  | "repeated_link"
  | "structural_rhythm"
  | "synchronous_publication";

export type RepetitionSeverity = "info" | "warn" | "high";

export interface RepetitionFinding {
  kind: RepetitionKind;
  severity: RepetitionSeverity;
  postIds: string[];
  platforms: string[];
  /** Operator-facing sentence carrying the actual numbers. */
  evidence: string;
  /** Machine-readable backing for the evidence string. */
  detail: Record<string, number | string | boolean>;
}

export interface RepetitionReport {
  postsAnalyzed: number;
  pairsCompared: number;
  findings: RepetitionFinding[];
  /** Highest cross-platform message similarity seen, as a percentage. */
  maxCrossPlatformPercent: number | null;
  /** Highest WITHIN-platform message similarity, for contrast. */
  maxWithinPlatformPercent: number | null;
  summary: string;
}

/**
 * Two posts published this close together on different platforms are a
 * machine signature. 30 minutes is generous: in the real corpus, seven of
 * the nine paired posts went out within FIVE minutes of each other, and
 * two within the same minute.
 */
export const NEAR_SYNCHRONOUS_MINUTES = 30;

/** Opening-hook reuse bar. Character-prefix overlap, not Jaccard. */
export const HOOK_REUSE_THRESHOLD = 0.6;

/** Paragraph-rhythm similarity bar (Jaccard over shape tokens). */
export const RHYTHM_SIMILARITY_THRESHOLD = 0.75;

export function analyzeRepetition(
  posts: readonly RepetitionPost[],
): RepetitionReport {
  const ordered = [...posts].sort(
    (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id),
  );
  const findings: RepetitionFinding[] = [];
  let pairsCompared = 0;
  let maxCross: number | null = null;
  let maxWithin: number | null = null;

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];
      pairsCompared += 1;

      const crossPlatform = a.platform !== b.platform;
      const message = messageSimilarity(a.body, b.body);
      const verbatim = verbatimSimilarity(a.body, b.body);
      const exact = isExactDuplicate(a.body, b.body);
      const minutesApart = minutesBetween(a.publishedAt, b.publishedAt);

      if (crossPlatform) {
        maxCross = Math.max(maxCross ?? 0, message);
      } else {
        maxWithin = Math.max(maxWithin ?? 0, message);
      }

      if (exact) {
        findings.push({
          kind: "exact_duplicate",
          severity: "high",
          postIds: [a.id, b.id],
          platforms: uniquePlatforms(a, b),
          evidence:
            `Identical copy after normalising case, punctuation and links` +
            (minutesApart != null ? `, published ${formatGap(minutesApart)} apart` : ""),
          detail: { messageSimilarityPercent: 100, crossPlatform, minutesApart: minutesApart ?? -1 },
        });
        continue;
      }

      if (crossPlatform) {
        const band = bandCrossPlatform({ verbatim, message, exact });
        if (band !== "none") {
          const synchronous =
            minutesApart != null && minutesApart <= NEAR_SYNCHRONOUS_MINUTES;
          findings.push({
            kind: "cross_platform_copy",
            severity: band === "warn" ? "warn" : "high",
            postIds: [a.id, b.id],
            platforms: uniquePlatforms(a, b),
            evidence:
              `Cross-platform similarity ${asPercent(message)}% ` +
              `(${a.platform} ↔ ${b.platform})` +
              (minutesApart != null ? ` · published ${formatGap(minutesApart)} apart` : "") +
              (synchronous ? " — near-simultaneous, which reads as automated" : ""),
            detail: {
              messageSimilarityPercent: asPercent(message),
              verbatimSimilarityPercent: asPercent(verbatim),
              minutesApart: minutesApart ?? -1,
              synchronous,
              band,
            },
          });
        }

        if (
          minutesApart != null &&
          minutesApart <= NEAR_SYNCHRONOUS_MINUTES &&
          message < CROSS_PLATFORM_WARN_THRESHOLD
        ) {
          // Different copy, same moment. Worth noting on its own — a
          // fixed publishing cadence is a footprint even when the words
          // differ.
          findings.push({
            kind: "synchronous_publication",
            severity: "info",
            postIds: [a.id, b.id],
            platforms: uniquePlatforms(a, b),
            evidence:
              `Published to ${a.platform} and ${b.platform} ${formatGap(minutesApart)} apart, ` +
              `with different copy (${asPercent(message)}% similar)`,
            detail: { minutesApart, messageSimilarityPercent: asPercent(message) },
          });
        }
      } else if (verbatim >= VERBATIM_THRESHOLD) {
        findings.push({
          kind: "near_duplicate",
          severity: "high",
          postIds: [a.id, b.id],
          platforms: [a.platform],
          evidence:
            `Two ${a.platform} posts share ${asPercent(verbatim)}% of their five-word sequences`,
          detail: { verbatimSimilarityPercent: asPercent(verbatim) },
        });
      }

      // Structural signals, reported regardless of platform pairing.
      const hookA = openingHook(a.body, a.title);
      const hookB = openingHook(b.body, b.title);
      const hookScore = hookSimilarity(hookA, hookB);
      if (hookA && hookB && hookScore >= HOOK_REUSE_THRESHOLD) {
        findings.push({
          kind: "repeated_opening",
          severity: crossPlatform ? "warn" : "info",
          postIds: [a.id, b.id],
          platforms: uniquePlatforms(a, b),
          evidence: `Both posts open the same way (${asPercent(hookScore)}% of the opening line matches)`,
          detail: { hookSimilarityPercent: asPercent(hookScore), crossPlatform },
        });
      }

      const ctaA = closingCta(a.body);
      const ctaB = closingCta(b.body);
      if (ctaA && ctaB && canonicalize(ctaA) === canonicalize(ctaB)) {
        findings.push({
          kind: "repeated_cta",
          severity: "warn",
          postIds: [a.id, b.id],
          platforms: uniquePlatforms(a, b),
          evidence: "Both posts end with the same call to action",
          detail: { cta: ctaA.slice(0, 80), crossPlatform },
        });
      }

      if (a.linkUrl && b.linkUrl && sameLinkTarget(a.linkUrl, b.linkUrl)) {
        findings.push({
          kind: "repeated_link",
          severity: "info",
          postIds: [a.id, b.id],
          platforms: uniquePlatforms(a, b),
          evidence: `Both posts point at the same destination (${hostOf(a.linkUrl)})`,
          detail: { host: hostOf(a.linkUrl) ?? "", crossPlatform },
        });
      }

      const rhythm = rhythmSimilarity(a.body, b.body);
      if (rhythm >= RHYTHM_SIMILARITY_THRESHOLD) {
        findings.push({
          kind: "structural_rhythm",
          severity: "info",
          postIds: [a.id, b.id],
          platforms: uniquePlatforms(a, b),
          evidence: `Both posts follow the same paragraph shape (${asPercent(rhythm)}% match)`,
          detail: { rhythmSimilarityPercent: asPercent(rhythm), crossPlatform },
        });
      }
    }
  }

  return {
    postsAnalyzed: ordered.length,
    pairsCompared,
    findings: findings.sort(sortBySeverityThenKind),
    maxCrossPlatformPercent: maxCross == null ? null : asPercent(maxCross),
    maxWithinPlatformPercent: maxWithin == null ? null : asPercent(maxWithin),
    summary: summarise(ordered.length, findings, maxCross, maxWithin),
  };
}

function summarise(
  postsAnalyzed: number,
  findings: RepetitionFinding[],
  maxCross: number | null,
  maxWithin: number | null,
): string {
  if (postsAnalyzed < 2) return "Not enough posts to compare.";
  const crossFindings = findings.filter((f) => f.kind === "cross_platform_copy");
  const parts: string[] = [];

  if (crossFindings.length > 0) {
    parts.push(
      `${crossFindings.length} cross-platform pair${crossFindings.length === 1 ? "" : "s"} ` +
        `reuse the same message` +
        (maxCross != null ? ` (highest ${asPercent(maxCross)}%)` : ""),
    );
  } else {
    parts.push("No cross-platform message reuse above the reporting threshold");
  }

  if (maxWithin != null) {
    parts.push(
      `highest similarity between two posts on the SAME platform is ${asPercent(maxWithin)}%`,
    );
  }

  return `${parts.join("; ")}.`;
}

// ---------------------------------------------------------------------
// structural extraction
// ---------------------------------------------------------------------

/** First non-empty line, or the title when one exists. */
export function openingHook(body: string, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

/** Last non-empty line — where a call to action normally sits. */
export function closingCta(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return "";
  return lines[lines.length - 1];
}

/**
 * Paragraph rhythm as a comparable SHAPE rather than an exact string.
 *
 * The existing platform-native detector compares rhythm by strict
 * equality, which only fires on identical structure. Bucketing each
 * paragraph by length and comparing the resulting sequence with Jaccard
 * catches "same skeleton, different words" — the dominant pattern in
 * Signal's corpus, where nearly every post is a short declarative
 * opener, a 2-4 line elaboration, and a closing aphorism.
 */
export function rhythmSimilarity(a: string, b: string): number {
  const shapeA = paragraphShape(a);
  const shapeB = paragraphShape(b);
  if (shapeA.length === 0 || shapeB.length === 0) return 0;
  return jaccard(shingles(shapeA, 1), shingles(shapeB, 1));
}

export function paragraphShape(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p, index) => {
      const words = tokenize(p).length;
      const bucket = words <= 8 ? "short" : words <= 25 ? "medium" : "long";
      const lines = p.split(/\r?\n/).filter((l) => l.trim()).length;
      return `${index}:${bucket}:${lines > 1 ? "multiline" : "single"}`;
    });
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

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

function uniquePlatforms(a: RepetitionPost, b: RepetitionPost): string[] {
  return Array.from(new Set([a.platform, b.platform])).sort();
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sameLinkTarget(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha != null && ha === hb;
}

const SEVERITY_RANK: Record<RepetitionSeverity, number> = {
  high: 0,
  warn: 1,
  info: 2,
};

function sortBySeverityThenKind(a: RepetitionFinding, b: RepetitionFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.kind.localeCompare(b.kind) ||
    a.postIds.join(",").localeCompare(b.postIds.join(","))
  );
}

export const REPETITION_THRESHOLDS = {
  crossPlatformWarn: CROSS_PLATFORM_WARN_THRESHOLD,
  crossPlatformHigh: CROSS_PLATFORM_HIGH_THRESHOLD,
  verbatim: VERBATIM_THRESHOLD,
  hookReuse: HOOK_REUSE_THRESHOLD,
  rhythm: RHYTHM_SIMILARITY_THRESHOLD,
  synchronousMinutes: NEAR_SYNCHRONOUS_MINUTES,
} as const;
