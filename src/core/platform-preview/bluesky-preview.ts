/**
 * Bluesky deterministic preview renderer.
 *
 * Rules applied:
 *   - 300 grapheme per-post budget (matches platform limit)
 *   - Threads split at sentence boundaries; first part includes any
 *     attached creative
 *   - Markdown stripped (Bluesky doesn't render Markdown)
 *   - Hashtags allowed but treated as foreign — flag density > 1.5
 *     tags/100 graphemes as warning
 *   - "this blew up" / engagement-bait phrases flagged as promotional
 *   - When alt_text missing on attached image, warn
 *   - Title is IGNORED on Bluesky (no post title concept) — we surface
 *     a one-time warning when the operator supplied one
 *
 * Pure. No I/O. No fake metrics.
 */

import type { PreviewInput, PreviewPart, PreviewResult, PreviewWarning } from "./preview-types";
import {
  emojiCount,
  graphemeCount,
  hashtagDensity,
  looksPromotional,
  pushWarning,
  splitIntoThreadParts,
  stripMarkdownForSocial,
} from "./preview-renderer";

const BUDGET = 300; // Bluesky grapheme cap

export function renderBlueskyPreview(input: PreviewInput): PreviewResult {
  const transformationNotes: string[] = [];
  const warnings: PreviewWarning[] = [];

  let body = input.body.trim();
  const original = body;
  body = stripMarkdownForSocial(body);
  if (body !== original) transformationNotes.push("Stripped Markdown.");

  if (input.title && input.title.trim().length > 0) {
    pushWarning(warnings, {
      kind: "title_ignored_by_platform",
      message:
        "Bluesky has no post title — only the body will appear in the feed.",
    });
  }

  const total = graphemeCount(body);
  let parts: PreviewPart[];
  if (total <= BUDGET) {
    parts = [
      {
        index: 1,
        total: 1,
        text: body,
        length: total,
        budget: BUDGET,
        truncated: false,
        showsCreative: input.creative !== null,
      },
    ];
  } else {
    const split = splitIntoThreadParts(body, BUDGET);
    transformationNotes.push(
      `Split into ${split.length} thread parts (Bluesky single-post limit: ${BUDGET} graphemes).`,
    );
    parts = split.map((text, i) => ({
      index: i + 1,
      total: split.length,
      text,
      length: graphemeCount(text),
      budget: BUDGET,
      truncated: false,
      showsCreative: i === 0 && input.creative !== null,
    }));
    if (split.length > 8) {
      pushWarning(warnings, {
        kind: "thread_too_long",
        message:
          "Threads longer than 8 posts feel desperate on Bluesky. Consider a single calm post.",
      });
    }
  }

  // Hashtag density
  const density = hashtagDensity(body);
  if (density >= 1.5) {
    pushWarning(warnings, {
      kind: "high_hashtag_density",
      message:
        "Hashtags read as foreign on Bluesky. Drop them unless they're load-bearing.",
    });
  }

  // Promotional
  if (looksPromotional(body)) {
    pushWarning(warnings, {
      kind: "too_promotional",
      message:
        "Phrases like 'this is huge' / 'must read' feel like X-style bait on Bluesky.",
    });
  }

  // Emoji density (sparse expected)
  const emoji = emojiCount(body);
  if (emoji > 3) {
    pushWarning(warnings, {
      kind: "emoji_dense",
      message: "Bluesky leans sparse on emoji — consider trimming.",
    });
  }

  // Alt text missing — only when an asset is attached
  if (
    input.creative &&
    input.creative.assetUrl &&
    (!input.creative.altText || input.creative.altText.trim().length === 0)
  ) {
    pushWarning(warnings, {
      kind: "alt_text_missing",
      message: "Image has no alt text — required for accessibility.",
      partIndex: 1,
    });
  }

  // First-post hook quality (very short single posts can feel empty)
  if (parts.length > 1 && parts[0].length < 40) {
    pushWarning(warnings, {
      kind: "first_post_too_short",
      message:
        "First post is very short — Bluesky readers often see only the first card.",
      partIndex: 1,
    });
  }

  return {
    platform: "bluesky",
    parts,
    identity: input.identity,
    creative: input.creative,
    warnings,
    totalLength: total,
    perPartBudget: BUDGET,
    unit: "graphemes",
    titleVisible: false,
    format: parts.length === 1 ? "single_post" : "thread",
    transformationNotes,
    creativeDirection: input.platformNativeDraft?.creativeDirection,
  };
}
