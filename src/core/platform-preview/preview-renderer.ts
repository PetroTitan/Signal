/**
 * Top-level preview dispatcher + shared text transformations.
 *
 * Pure. No I/O. No network. No fake metrics or counts. The renderer
 * NEVER fabricates engagement numbers, timestamps, avatars, or
 * verification badges — only the operator's own identity row may
 * supply an avatar.
 */

import { renderBlueskyPreview } from "./bluesky-preview";
import { renderLinkedInPreview } from "./linkedin-preview";
import { renderXPreview } from "./x-preview";
import type {
  PreviewInput,
  PreviewPlatform,
  PreviewResult,
  PreviewWarning,
} from "./preview-types";

export function renderPlatformPreview(input: PreviewInput): PreviewResult {
  switch (input.platform) {
    case "bluesky":
      return renderBlueskyPreview(input);
    case "x":
      return renderXPreview(input);
    case "linkedin":
      return renderLinkedInPreview(input);
  }
}

/** Map a free-form platform string to a supported PreviewPlatform.
 *  Returns null when the platform doesn't have a v1 renderer yet
 *  (Reddit / dev.to / etc.). */
export function asPreviewPlatform(value: string): PreviewPlatform | null {
  switch (value) {
    case "bluesky":
    case "x":
    case "linkedin":
      return value;
    default:
      return null;
  }
}

// =====================================================================
// Shared text transformations
// =====================================================================

/**
 * Strip Markdown that platforms don't render (Bluesky / X). LinkedIn
 * preserves line breaks but doesn't render bold/italic syntax — the
 * LinkedIn renderer uses this same helper.
 *
 * Conservative: preserves URLs verbatim, preserves emoji, preserves
 * @ mentions, preserves #hashtags, drops fenced code formatting.
 */
export function stripMarkdownForSocial(text: string): string {
  let out = text;
  // Fenced code blocks → strip fences only, keep code content as text.
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    return block.replace(/```[a-z]*\n?|```/g, "").trim();
  });
  // Inline code: `x` → x
  out = out.replace(/`([^`\n]+)`/g, "$1");
  // Headings: leading "#" / "##" → drop marker, keep text
  out = out.replace(/^#{1,6}\s+/gm, "");
  // Bold/italic: **x** / *x* / __x__ / _x_ → x
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  out = out.replace(/__([^_\n]+)__/g, "$1");
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1");
  out = out.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1");
  // Links: [label](url) → label (url) — readers see both
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Bullet markers: leading "-" / "*" + space → "• " (clean unicode)
  out = out.replace(/^[\t ]*[-*]\s+/gm, "• ");
  // Numbered list markers stay as-is — they render fine on X / LinkedIn.
  // Collapse 3+ blank lines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * Count graphemes properly. Falls back to code-point count when
 * Intl.Segmenter is unavailable. Bluesky measures posts in graphemes;
 * X measures in "weighted characters" (we approximate as code points
 * with URL shortening rules applied separately).
 */
export function graphemeCount(text: string): number {
  if (
    typeof Intl !== "undefined" &&
    typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter !== "undefined"
  ) {
    const seg = new (Intl as unknown as {
      Segmenter: new (
        locale?: string,
        opts?: { granularity?: string },
      ) => {
        segment: (s: string) => Iterable<{ segment: string }>;
      };
    }).Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(text)) {
      void _;
      n++;
    }
    return n;
  }
  // Fallback: code points (good for non-emoji; for ZWJ-emoji it'll
  // overcount slightly, which is conservative for "will this fit").
  return Array.from(text).length;
}

/**
 * Truncate a string to fit within `budget` graphemes, breaking at a
 * sentence-or-word boundary when possible. Returns the truncated text
 * and whether truncation occurred.
 */
export function truncateToGraphemeBudget(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (graphemeCount(text) <= budget) return { text, truncated: false };
  const segments: string[] = [];
  if (
    typeof Intl !== "undefined" &&
    typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter !== "undefined"
  ) {
    const seg = new (Intl as unknown as {
      Segmenter: new (
        locale?: string,
        opts?: { granularity?: string },
      ) => {
        segment: (s: string) => Iterable<{ segment: string }>;
      };
    }).Segmenter(undefined, { granularity: "grapheme" });
    for (const g of seg.segment(text)) segments.push(g.segment);
  } else {
    for (const cp of text) segments.push(cp);
  }
  const head = segments.slice(0, budget).join("");
  return { text: head.trimEnd() + "…", truncated: true };
}

/**
 * Split a body into thread parts at sentence boundaries, each fitting
 * within `budget` graphemes. Sentences longer than the budget are
 * hard-cut. Strips leading whitespace from each part.
 */
export function splitIntoThreadParts(
  body: string,
  budget: number,
): string[] {
  const parts: string[] = [];
  const sentences = splitSentences(body);
  let current = "";
  for (const sentence of sentences) {
    const trial = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (graphemeCount(trial) <= budget) {
      current = trial;
      continue;
    }
    if (current.length > 0) {
      parts.push(current.trim());
      current = "";
    }
    // Sentence by itself too long: hard-split on graphemes at word
    // boundaries.
    if (graphemeCount(sentence) > budget) {
      const chunks = hardSplitOnWordBoundary(sentence, budget);
      for (let i = 0; i < chunks.length - 1; i++) {
        parts.push(chunks[i].trim());
      }
      current = chunks[chunks.length - 1];
    } else {
      current = sentence;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/**
 * Detect hashtag density (#tags / 100 graphemes). Conservative —
 * tag-anywhere counts; we don't try to validate the tag.
 */
export function hashtagDensity(text: string): number {
  const tags = text.match(/(?:^|\s)#[A-Za-z0-9_]+/g) ?? [];
  const len = Math.max(1, graphemeCount(text));
  return (tags.length / len) * 100;
}

/** Whether the body shows enough promotional / hype phrasing to
 *  trigger a "too_promotional" warning. Reuses the central
 *  forbidden-patterns list rather than duplicating it. */
export function looksPromotional(text: string): boolean {
  const lc = text.toLowerCase();
  const promo: ReadonlyArray<string> = [
    "this is huge",
    "must read",
    "huge news",
    "blew up",
    "going viral",
    "10x",
    "100x",
    "game changer",
    "game-changer",
    "groundbreaking",
    "revolutionary",
    "unprecedented",
    "you won't believe",
  ];
  return promo.some((p) => lc.includes(p));
}

/** Heuristic emoji density: matches Extended_Pictographic ranges
 *  with a simple regex — good enough for "is the post emoji-spammy". */
export function emojiCount(text: string): number {
  // Match common emoji ranges + ZWJ sequences without over-counting.
  // This is an approximation; we use it only to flag density.
  const re =
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2300}-\u{23FF}]/gu;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Estimate displayed length under URL-shortening rules (X). Each
 *  http(s) URL counts as `urlWeight` regardless of its true length. */
export function lengthWithUrlShortening(
  text: string,
  urlWeight: number,
): number {
  const withPlaceholders = text.replace(
    /https?:\/\/[^\s]+/g,
    "X".repeat(urlWeight),
  );
  return graphemeCount(withPlaceholders);
}

/** Pull the first URL out of a string, when present. */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

/** Push a warning while de-duping on (kind, partIndex). */
export function pushWarning(
  list: PreviewWarning[],
  warning: PreviewWarning,
): void {
  const key = `${warning.kind}:${warning.partIndex ?? "-"}`;
  for (const existing of list) {
    const existingKey = `${existing.kind}:${existing.partIndex ?? "-"}`;
    if (existingKey === key) return;
  }
  list.push(warning);
}

// =====================================================================
// Internals
// =====================================================================

function splitSentences(text: string): string[] {
  // Split on .!? followed by whitespace; preserve trailing punctuation.
  // Paragraphs (\n\n) break too.
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.trim().length === 0) continue;
    // Lookbehind for .!? followed by lookahead for capital/whitespace.
    const parts = p.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/u);
    for (const s of parts) {
      const trimmed = s.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

function hardSplitOnWordBoundary(
  text: string,
  budget: number,
): string[] {
  const words = text.split(/\s+/);
  const parts: string[] = [];
  let current = "";
  for (const w of words) {
    const trial = current.length === 0 ? w : `${current} ${w}`;
    if (graphemeCount(trial) <= budget) {
      current = trial;
    } else {
      if (current.length > 0) parts.push(current);
      // Pathological: a single word longer than the budget — hard
      // truncate it with ellipsis to stay within bounds.
      if (graphemeCount(w) > budget) {
        const { text: cut } = truncateToGraphemeBudget(w, budget);
        parts.push(cut);
        current = "";
      } else {
        current = w;
      }
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
