/**
 * Deterministic rewrite engine — no AI provider required.
 *
 * Fallback for the editorial-rewrite chips when ANTHROPIC_API_KEY /
 * OPENAI_API_KEY are not configured. Uses the platform-native style
 * profiles + forbidden-patterns scanner to make small, predictable
 * edits that are obviously below what an AI rewrite would produce —
 * but obviously better than a dead button. Surfaces a transparent
 * "deterministic adaptation applied" receipt so operators are never
 * misled about what happened.
 *
 * Pure module. No I/O. No DB. No network. No randomness.
 */

import {
  PLATFORM_FORBIDDEN_PATTERNS,
  PLATFORM_STYLE_PROFILES,
  type PlatformViolation,
} from "@/core/platform-native";
import type { RewriteAction } from "./rewrite-types";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

const PLATFORM_FROM_ACTION: Partial<Record<RewriteAction, FounderPlatform>> = {
  to_bluesky_thread: "bluesky",
  to_devto_article: "devto",
  to_x_thread: "x",
  to_linkedin_post: "linkedin",
  to_youtube_description: "youtube",
  to_threads_post: "threads",
  to_instagram_caption: "instagram",
};

/**
 * Generic hype/promotional phrases that we strip on `less_promotional`
 * regardless of platform. Platform-specific forbidden patterns get
 * stripped on top of these by `stripForbidden`.
 */
const GENERIC_HYPE_PATTERNS: ReadonlyArray<string> = [
  "must read",
  "huge news",
  "you won't believe",
  "this is insane",
  "this is huge",
  "blew up",
  "going viral",
  "10x",
  "100x",
  "game changer",
  "game-changer",
  "groundbreaking",
  "revolutionary",
  "unprecedented",
];

/**
 * CTA / engagement-bait closers we drop on `less_promotional`.
 * Matches whole-line and end-of-line.
 */
const CTA_LINE_PATTERNS: ReadonlyArray<RegExp> = [
  /^.*\b(thoughts|agree|let'?s discuss|comment below|drop a comment|hit (?:like|subscribe)|smash (?:like|subscribe))\b.*[?!.]?$/i,
  /^.*\b(follow for (?:more|daily)|link in bio|sub(?:scribe)?( to)? (?:my|the) newsletter)\b.*[?!.]?$/i,
  /^.*\b(dm me for|limited spots|early access only)\b.*[?!.]?$/i,
];

export interface DeterministicRewriteInput {
  action: RewriteAction;
  currentTitle: string | null;
  currentBody: string;
  /** Plan-item platform — used as fallback when action is non-platform-specific. */
  platform: string;
}

export type DeterministicRewriteResult =
  | {
      ok: true;
      action: RewriteAction;
      newTitle: string | null;
      newBody: string | null;
      /** Operator-readable summary of the edits applied. */
      receipt: string;
    }
  | {
      ok: false;
      action: RewriteAction;
      reason: "no_body" | "no_change" | "not_supported";
      detail: string;
    };

export function deterministicRewrite(
  input: DeterministicRewriteInput,
): DeterministicRewriteResult {
  if (!input.currentBody || input.currentBody.trim().length === 0) {
    return {
      ok: false,
      action: input.action,
      reason: "no_body",
      detail: "Write something first — there's no draft to adapt.",
    };
  }

  switch (input.action) {
    case "improve_headline":
      return rewriteImproveHeadline(input.currentTitle);

    case "shorter":
      return rewriteShorter(input.action, input.currentBody);

    case "less_promotional":
      return rewriteLessPromotional(
        input.action,
        input.currentBody,
        resolvePlatform(input.platform),
      );

    case "to_bluesky_thread":
    case "to_devto_article":
    case "to_x_thread":
    case "to_linkedin_post":
    case "to_youtube_description":
    case "to_threads_post":
    case "to_instagram_caption":
      return rewriteAdaptForPlatform(
        input.action,
        input.currentBody,
        PLATFORM_FROM_ACTION[input.action]!,
      );

    case "rewrite":
    case "more_technical":
    case "more_founder":
      return rewriteGenericCleanup(input.action, input.currentBody);
  }
}

// =====================================================================
// Per-action implementations
// =====================================================================

function rewriteImproveHeadline(
  currentTitle: string | null,
): DeterministicRewriteResult {
  if (!currentTitle || currentTitle.trim().length === 0) {
    return {
      ok: false,
      action: "improve_headline",
      reason: "no_change",
      detail: "There's no headline yet. Add a title first.",
    };
  }
  let headline = currentTitle.trim();
  // Strip surrounding quotes / backticks the operator may have added.
  headline = headline.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Drop trailing punctuation other than ? and !.
  headline = headline.replace(/[.,;:]+$/g, "").trim();
  // Collapse internal runs of whitespace.
  headline = headline.replace(/\s+/g, " ");
  // Drop leading "Title:" / "Headline:" labels if present.
  headline = headline.replace(/^(title|headline|tldr|tl;dr)\s*[:\-]\s*/i, "");
  // Cap to 80 characters at a word boundary, no ellipsis.
  if (headline.length > 80) {
    const cut = headline.slice(0, 80);
    const lastSpace = cut.lastIndexOf(" ");
    headline = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  }
  if (headline === currentTitle) {
    return {
      ok: false,
      action: "improve_headline",
      reason: "no_change",
      detail: "Headline already looks tight.",
    };
  }
  return {
    ok: true,
    action: "improve_headline",
    newTitle: headline,
    newBody: null,
    receipt: "Deterministic title cleanup (trim, dequote, depunctuate).",
  };
}

function rewriteShorter(
  action: RewriteAction,
  body: string,
): DeterministicRewriteResult {
  const original = body.trim();
  const targetChars = Math.max(120, Math.floor(original.length * 0.6));
  const shortened = compressToTarget(original, targetChars);
  if (shortened === original) {
    return {
      ok: false,
      action,
      reason: "no_change",
      detail: "Draft is already concise.",
    };
  }
  return {
    ok: true,
    action,
    newTitle: null,
    newBody: shortened,
    receipt: `Compressed to ~${shortened.length} characters (from ${original.length}).`,
  };
}

function rewriteLessPromotional(
  action: RewriteAction,
  body: string,
  platform: FounderPlatform | null,
): DeterministicRewriteResult {
  const violations: string[] = [];
  let next = body;

  for (const phrase of GENERIC_HYPE_PATTERNS) {
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
    if (re.test(next)) {
      violations.push(phrase);
      next = next.replace(re, "").replace(/\s{2,}/g, " ");
    }
  }

  if (platform) {
    const platformBanned = PLATFORM_FORBIDDEN_PATTERNS[platform];
    for (const phrase of platformBanned) {
      const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
      if (re.test(next)) {
        violations.push(phrase);
        next = next.replace(re, "").replace(/\s{2,}/g, " ");
      }
    }
  }

  next = next
    .split("\n")
    .filter((line) => !CTA_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (next === body.trim()) {
    return {
      ok: false,
      action,
      reason: "no_change",
      detail: "No promotional phrases or CTA closers detected.",
    };
  }

  const unique = Array.from(new Set(violations));
  const summary =
    unique.length > 0
      ? `Removed: ${unique.slice(0, 3).join(", ")}${unique.length > 3 ? "…" : ""}.`
      : "Removed CTA / engagement-bait closer.";
  return {
    ok: true,
    action,
    newTitle: null,
    newBody: next,
    receipt: `Stripped promotional phrasing. ${summary}`,
  };
}

function rewriteAdaptForPlatform(
  action: RewriteAction,
  body: string,
  platform: FounderPlatform,
): DeterministicRewriteResult {
  const profile = PLATFORM_STYLE_PROFILES[platform];
  let next = body.trim();
  const notes: string[] = [];

  if (profile.hashtagPolicy.toLowerCase().includes("zero") ||
      profile.hashtagPolicy.toLowerCase().includes("no ") ||
      profile.hashtagPolicy.toLowerCase().includes("avoid")) {
    const before = next;
    next = next.replace(/(^|\s)#[A-Za-z0-9_]+/g, "$1").replace(/\s{2,}/g, " ");
    if (next !== before) notes.push("removed hashtags");
  }

  const violations = scanLocalViolations(next, platform);
  for (const v of violations) {
    const re = new RegExp(`\\b${escapeRegex(v)}\\b`, "gi");
    next = next.replace(re, "").replace(/\s{2,}/g, " ");
  }
  if (violations.length > 0) {
    notes.push(`stripped ${violations.length} forbidden phrase${violations.length === 1 ? "" : "s"}`);
  }

  const targetChars = platformTargetChars(platform);
  if (targetChars !== null && next.length > targetChars) {
    next = compressToTarget(next, targetChars);
    notes.push(`compressed to ~${next.length} chars`);
  }

  next = next
    .split("\n")
    .filter((line) => !CTA_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (next === body.trim()) {
    return {
      ok: false,
      action,
      reason: "no_change",
      detail: `Draft already fits ${profile.platform} style.`,
    };
  }
  const summary = notes.length > 0 ? notes.join(", ") : "platform style applied";
  return {
    ok: true,
    action,
    newTitle: null,
    newBody: next,
    receipt: `Adapted for ${profile.platform} (${summary}).`,
  };
}

function rewriteGenericCleanup(
  action: RewriteAction,
  body: string,
): DeterministicRewriteResult {
  const trimmed = body.trim();
  const cleaned = trimmed
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
  if (cleaned === trimmed) {
    return {
      ok: false,
      action,
      reason: "no_change",
      detail:
        "Advanced AI rewrite isn't available — deterministic cleanup found nothing to change.",
    };
  }
  return {
    ok: true,
    action,
    newTitle: null,
    newBody: cleaned,
    receipt:
      "Advanced AI rewrite unavailable. Deterministic whitespace cleanup applied.",
  };
}

// =====================================================================
// Helpers
// =====================================================================

function resolvePlatform(value: string): FounderPlatform | null {
  const allowed: FounderPlatform[] = [
    "reddit",
    "devto",
    "hashnode",
    "bluesky",
    "indie_hackers",
    "x",
    "linkedin",
    "youtube",
    "threads",
    "instagram",
    "telegram",
  ];
  return (allowed as string[]).includes(value)
    ? (value as FounderPlatform)
    : null;
}

function platformTargetChars(platform: FounderPlatform): number | null {
  switch (platform) {
    case "bluesky":
      return 280;
    case "x":
      return 240;
    case "threads":
      return 480;
    case "instagram":
      return 600;
    case "linkedin":
      return 1400;
    case "devto":
    case "hashnode":
      return null; // long-form
    case "youtube":
      return 5000;
    case "reddit":
    case "indie_hackers":
    case "telegram":
      return null;
  }
}

function compressToTarget(text: string, targetChars: number): string {
  if (text.length <= targetChars) return text;
  // Prefer to truncate at paragraph boundary first.
  const paragraphs = text.split(/\n{2,}/);
  let assembled = "";
  for (const p of paragraphs) {
    const candidate = assembled.length === 0 ? p : `${assembled}\n\n${p}`;
    if (candidate.length > targetChars) break;
    assembled = candidate;
  }
  if (assembled.length === 0) {
    // First paragraph already too long — truncate to the closest sentence end
    // within target.
    const cut = text.slice(0, targetChars);
    const lastSentence = Math.max(
      cut.lastIndexOf(". "),
      cut.lastIndexOf("! "),
      cut.lastIndexOf("? "),
    );
    return lastSentence > targetChars / 2
      ? cut.slice(0, lastSentence + 1)
      : cut.trimEnd();
  }
  return assembled;
}

function scanLocalViolations(
  text: string,
  platform: FounderPlatform,
): string[] {
  const patterns = PLATFORM_FORBIDDEN_PATTERNS[platform];
  const found: string[] = [];
  for (const phrase of patterns) {
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
    if (re.test(text)) found.push(phrase);
  }
  return found;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unused but exported for diagnostics symmetry with platform-native module.
export type { PlatformViolation };
