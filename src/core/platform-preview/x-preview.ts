/**
 * X / Twitter deterministic preview renderer.
 *
 * Rules applied:
 *   - 280-char budget per tweet
 *   - URLs collapse to 23 chars (t.co weight); approximated via
 *     lengthWithUrlShortening for the budget check, but the visible
 *     text keeps the operator's URL so they can see what they wrote
 *   - Threads split at sentence boundaries; first tweet carries the
 *     attached media
 *   - Markdown stripped
 *   - Hashtag density warning at >= 1 tag/30 chars (X flags spam fast)
 *   - "agree?" / "thoughts?" / "this is huge" promotional flag
 *   - Hard truncation (visible "…") only when a single sentence
 *     exceeds the budget — the body of the preview keeps the
 *     operator's original until then
 *   - No fake engagement counts, no verification ticks
 */

import type { PreviewInput, PreviewPart, PreviewResult, PreviewWarning } from "./preview-types";
import {
  emojiCount,
  graphemeCount,
  hashtagDensity,
  lengthWithUrlShortening,
  looksPromotional,
  pushWarning,
  splitIntoThreadParts,
  stripMarkdownForSocial,
} from "./preview-renderer";

const BUDGET = 280;
const URL_WEIGHT = 23;

export function renderXPreview(input: PreviewInput): PreviewResult {
  const transformationNotes: string[] = [];
  const warnings: PreviewWarning[] = [];

  let body = input.body.trim();
  const original = body;
  body = stripMarkdownForSocial(body);
  if (body !== original) transformationNotes.push("Stripped Markdown.");

  if (input.title && input.title.trim().length > 0) {
    pushWarning(warnings, {
      kind: "title_ignored_by_platform",
      message: "X has no post title — only the tweet body appears.",
    });
  }

  // The split uses the URL-shortened length for budgeting so a tweet
  // with a long URL doesn't get falsely split.
  const totalShortened = lengthWithUrlShortening(body, URL_WEIGHT);
  let parts: PreviewPart[];

  if (totalShortened <= BUDGET) {
    parts = [
      {
        index: 1,
        total: 1,
        text: body,
        length: totalShortened,
        budget: BUDGET,
        truncated: false,
        showsCreative: input.creative !== null,
      },
    ];
  } else {
    // Build a virtual "budget-aware" body by replacing URLs with
    // placeholders of the right weight, splitting, then re-injecting.
    const split = splitWithUrlAwareness(body, BUDGET, URL_WEIGHT);
    transformationNotes.push(
      `Split into ${split.length} thread parts (X tweet limit: ${BUDGET} characters, URLs count as ${URL_WEIGHT}).`,
    );
    parts = split.map((text, i) => ({
      index: i + 1,
      total: split.length,
      text,
      length: lengthWithUrlShortening(text, URL_WEIGHT),
      budget: BUDGET,
      truncated: lengthWithUrlShortening(text, URL_WEIGHT) > BUDGET,
      showsCreative: i === 0 && input.creative !== null,
    }));

    if (split.length >= 10) {
      pushWarning(warnings, {
        kind: "thread_too_long",
        message:
          "Threads over 10 posts feel desperate on X. Consider a single observation.",
      });
    }
    if (parts.some((p) => p.truncated)) {
      pushWarning(warnings, {
        kind: "likely_truncated",
        message: "A part exceeds 280 chars even after the split — review.",
      });
    }
  }

  // Hashtag density: X tolerates more than Bluesky but flag spam
  const density = hashtagDensity(body);
  if (density >= 3) {
    pushWarning(warnings, {
      kind: "high_hashtag_density",
      message: "Hashtag density looks like marketing spam on X.",
    });
  }

  // Promotional / engagement bait
  if (
    looksPromotional(body) ||
    /\b(agree\?|thoughts\?|let'?s discuss|comment below)/i.test(body)
  ) {
    pushWarning(warnings, {
      kind: "too_promotional",
      message:
        "X readers ignore 'agree?' / 'thoughts?' closers — drop the engagement bait.",
    });
  }

  // Emoji density
  if (emojiCount(body) > 4) {
    pushWarning(warnings, {
      kind: "emoji_dense",
      message: "Lots of emoji on X reads as bot/marketing.",
    });
  }

  // Alt text on attached media
  if (
    input.creative &&
    input.creative.assetUrl &&
    (!input.creative.altText || input.creative.altText.trim().length === 0)
  ) {
    pushWarning(warnings, {
      kind: "alt_text_missing",
      message: "Image has no alt text — X marks tweets with empty alt.",
      partIndex: 1,
    });
  }

  return {
    platform: "x",
    parts,
    identity: input.identity,
    creative: input.creative,
    warnings,
    totalLength: totalShortened,
    perPartBudget: BUDGET,
    unit: "chars",
    titleVisible: false,
    format: parts.length === 1 ? "single_post" : "thread",
    transformationNotes,
    creativeDirection: input.platformNativeDraft?.creativeDirection,
  };
}

/**
 * Split a body into parts, treating URLs as URL_WEIGHT-character
 * tokens. The returned strings preserve the operator's URL verbatim
 * so the preview shows what they wrote.
 */
function splitWithUrlAwareness(
  body: string,
  budget: number,
  urlWeight: number,
): string[] {
  // Trick: replace URLs with a stable token of length urlWeight, do
  // the normal split, then put URLs back. Each URL gets a unique
  // token to allow round-trip mapping.
  const urls: string[] = [];
  const tokenized = body.replace(/https?:\/\/[^\s]+/g, (url) => {
    const idx = urls.length;
    urls.push(url);
    // Tokens of length urlWeight to mimic t.co length.
    return `__U${String(idx).padStart(2, "0")}${"x".repeat(Math.max(0, urlWeight - 5))}__`;
  });
  const parts = splitIntoThreadParts(tokenized, budget);
  // Restore URLs.
  return parts.map((p) =>
    p.replace(/__U(\d{2})x*__/g, (_, idxStr) => urls[Number(idxStr)] ?? ""),
  );
}
