/**
 * Per-platform forbidden patterns — pure data + a scanner.
 *
 * These are platform-specific. The global banned-phrases list in
 * src/core/generation/safety-rules.ts catches universal violations
 * (fake authority, fabrication). This file adds per-platform rules
 * that would be wrong ONLY on that platform — e.g. "agree?" on
 * LinkedIn, "smash like" on YouTube, hashtag blocks on Bluesky.
 *
 * Two surfaces:
 *   1. PLATFORM_FORBIDDEN_PATTERNS — used by the prompt builder to
 *      inject a "do not write" list into the system prompt.
 *   2. scanForPlatformViolations — used post-generation to flag any
 *      forbidden pattern that slipped past the prompt.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";

// =====================================================================
// Pattern definitions
//
// Strings are case-insensitive substring matches. We use strings (not
// regex) so the lists stay readable and so they can be surfaced
// verbatim in operator-facing findings.
// =====================================================================

const reddit: ReadonlyArray<string> = [
  "must read",
  "huge news",
  "blew up",
  // Reddit communities specifically dislike subreddit-name flattery
  // in the opening line.
  "as someone in r/",
  "love this subreddit",
];

const x: ReadonlyArray<string> = [
  "this is huge",
  "must read",
  "blew up",
  "agree?",
  "thoughts?",
  "wild",
  // Reddit-style discussion framing is the #1 cross-platform leak.
  "let's discuss",
  "what do you think?",
];

const bluesky: ReadonlyArray<string> = [
  "this blew up",
  "follow for daily",
  "algorithm",
  "rage take",
  "must read",
];

const linkedin: ReadonlyArray<string> = [
  "i'm thrilled",
  "i'm honored",
  "i'm humbled",
  "thrilled to announce",
  "we are excited to announce",
  "agree?",
  "thoughts?",
  "let's discuss",
  "what do you think?",
  "i'll never forget the moment",
];

const threads: ReadonlyArray<string> = [
  "this blew up",
  "comment below",
  "follow for daily",
  "algorithm loves",
  "must read",
];

const instagram: ReadonlyArray<string> = [
  "link in bio",
  "double tap",
  "manifest",
  "7-figure",
  "7 figure",
  "dm me for",
  "limited spots",
  "go viral",
];

const telegram: ReadonlyArray<string> = [
  "join now",
  "limited spots",
  "exclusive leak",
  "dm me for",
  "private method",
  "early access only",
];

const devto: ReadonlyArray<string> = [
  "subscribe to my newsletter",
  "smash that subscribe",
  // Discussion framing is the wrong shape for dev.to.
  "what do you think?",
  "agree?",
];

const hashnode: ReadonlyArray<string> = [
  "subscribe to my newsletter",
  // Hashnode is for architecture / design rationale — social-post
  // shape patterns are wrong here.
  "this blew up",
  "agree?",
  "thoughts?",
];

const youtube: ReadonlyArray<string> = [
  "smash like",
  "smash the like",
  "don't forget to subscribe",
  "watch until the end",
  "watch till the end",
  "this video is going to change",
  "the algorithm",
  "wait for it",
];

const indieHackers: ReadonlyArray<string> = [
  "we just hit",
  "crushing it",
  "killing it",
  "next unicorn",
  // Fake-traction-shaped phrasing.
  "skyrocketed",
];

export const PLATFORM_FORBIDDEN_PATTERNS: Record<
  FounderPlatform,
  ReadonlyArray<string>
> = {
  reddit,
  x,
  bluesky,
  linkedin,
  threads,
  instagram,
  telegram,
  devto,
  hashnode,
  youtube,
  indie_hackers: indieHackers,
};

export function getForbiddenPatterns(
  platform: FounderPlatform,
): ReadonlyArray<string> {
  return PLATFORM_FORBIDDEN_PATTERNS[platform];
}

// =====================================================================
// Scanner — used post-generation as a guardrail
// =====================================================================

export interface PlatformViolation {
  pattern: string;
  /** Where the pattern surfaced — operator-facing. */
  location: "hook" | "body" | "cta";
}

/**
 * Pure substring scan, case-insensitive. Returns every violation;
 * callers decide severity. Empty array means clean.
 */
export function scanForPlatformViolations(input: {
  platform: FounderPlatform;
  hook: string;
  body: string;
  cta: string | null;
}): ReadonlyArray<PlatformViolation> {
  const patterns = getForbiddenPatterns(input.platform);
  const out: PlatformViolation[] = [];
  const checks: ReadonlyArray<{ text: string; location: "hook" | "body" | "cta" }> = [
    { text: input.hook, location: "hook" },
    { text: input.body, location: "body" },
    { text: input.cta ?? "", location: "cta" },
  ];
  for (const { text, location } of checks) {
    const lower = text.toLowerCase();
    for (const p of patterns) {
      if (lower.includes(p.toLowerCase())) {
        out.push({ pattern: p, location });
      }
    }
  }
  return out;
}
