/**
 * LinkedIn deterministic preview renderer.
 *
 * Rules applied:
 *   - Single-post format (no threading on LinkedIn)
 *   - "See more" cutoff: feed shows roughly the first 210 chars on
 *     desktop / 140 on mobile. We model 210; render the rest as
 *     "below the fold".
 *   - 3000-char hard limit
 *   - Markdown stripped (LinkedIn renders newlines but not markdown)
 *   - Corporate-tone warnings: "thrilled to announce" / "humbled" /
 *     "we are excited"
 *   - Engagement-bait warnings: "agree?" / "thoughts?"
 *   - Hashtag density tolerated (LinkedIn norms allow ~3 tags) but
 *     flag spam at > 5
 *   - External-link-heavy warning when > 2 URLs in body
 *   - Emoji-density warning over 3
 */

import type { PreviewInput, PreviewPart, PreviewResult, PreviewWarning } from "./preview-types";
import {
  emojiCount,
  graphemeCount,
  pushWarning,
  stripMarkdownForSocial,
} from "./preview-renderer";

const HARD_LIMIT = 3000;
const SEE_MORE_CUTOFF = 210;

export function renderLinkedInPreview(input: PreviewInput): PreviewResult {
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
        "LinkedIn has no post title — the first sentence acts as the headline in the feed.",
    });
  }

  let length = graphemeCount(body);
  let truncated = false;
  if (length > HARD_LIMIT) {
    body = body.slice(0, HARD_LIMIT).trimEnd() + "…";
    length = graphemeCount(body);
    truncated = true;
    pushWarning(warnings, {
      kind: "likely_truncated",
      message: `LinkedIn limit is ${HARD_LIMIT} characters — the post was truncated.`,
      partIndex: 1,
    });
  }

  if (length > SEE_MORE_CUTOFF) {
    transformationNotes.push(
      `Above ${SEE_MORE_CUTOFF} chars — readers see "…see more" after the first ~210 chars.`,
    );
  }

  const corporatePhrases =
    /(i'?m\s+(?:thrilled|honored|humbled)|thrilled\s+to\s+announce|we\s+are\s+excited\s+to\s+announce|i'?ll\s+never\s+forget\s+the\s+moment)/i;
  if (corporatePhrases.test(body)) {
    pushWarning(warnings, {
      kind: "corporate_tone",
      message:
        "Reads like a corporate announcement — LinkedIn audiences glaze past 'I'm thrilled' openers.",
    });
  }

  if (/\b(agree\?|thoughts\?|let'?s discuss|comment below)/i.test(body)) {
    pushWarning(warnings, {
      kind: "too_promotional",
      message:
        "Engagement-bait closers ('thoughts?' / 'agree?') feel dated on LinkedIn.",
    });
  }

  const urls = body.match(/https?:\/\/[^\s]+/g) ?? [];
  if (urls.length > 2) {
    pushWarning(warnings, {
      kind: "external_link_heavy",
      message:
        "Multiple outbound links suppress LinkedIn distribution — put the main link last.",
    });
  }

  const tags = body.match(/(?:^|\s)#[A-Za-z0-9_]+/g) ?? [];
  if (tags.length > 5) {
    pushWarning(warnings, {
      kind: "high_hashtag_density",
      message: "5+ hashtags reads as keyword stuffing on LinkedIn.",
    });
  }

  if (emojiCount(body) > 3) {
    pushWarning(warnings, {
      kind: "emoji_dense",
      message: "LinkedIn norms favor at most one or two meaningful emoji.",
    });
  }

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

  const parts: PreviewPart[] = [
    {
      index: 1,
      total: 1,
      text: body,
      length,
      budget: HARD_LIMIT,
      truncated,
      showsCreative: input.creative !== null,
    },
  ];

  return {
    platform: "linkedin",
    parts,
    identity: input.identity,
    creative: input.creative,
    warnings,
    totalLength: length,
    perPartBudget: HARD_LIMIT,
    unit: "chars",
    titleVisible: false,
    format: "single_post",
    transformationNotes,
    creativeDirection: input.platformNativeDraft?.creativeDirection,
  };
}

/** Exposed for the UI: the position in the body at which "...see
 *  more" appears in the feed. Returns null when the post is below
 *  the cutoff. */
export function linkedInSeeMoreOffset(text: string): number | null {
  return graphemeCount(text) > SEE_MORE_CUTOFF ? SEE_MORE_CUTOFF : null;
}
