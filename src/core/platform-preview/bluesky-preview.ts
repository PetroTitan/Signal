/**
 * Bluesky deterministic preview renderer.
 *
 * Source of truth for the thread shape, media placement, and creative
 * validation is `src/core/publishing/bluesky-payload.ts` —
 * `prepareBlueskyThreadPayload`. The preview consumes that shared
 * payload and translates it into the operator-facing `PreviewResult`,
 * adding social-quality warnings (hashtag density, promotional tone,
 * emoji density, short-first-post). The shared layer is also called
 * by the publisher, so what the operator sees in the preview is what
 * the publisher writes.
 *
 * Pure. No I/O. No fake metrics.
 */

import type {
  PreviewInput,
  PreviewPart,
  PreviewResult,
  PreviewWarning,
} from "./preview-types";
import {
  BLUESKY_POST_BUDGET,
  prepareBlueskyThreadPayload,
} from "@/core/publishing/bluesky-payload";
import {
  emojiCount,
  graphemeCount,
  hashtagDensity,
  looksPromotional,
  pushWarning,
} from "./preview-renderer";

export function renderBlueskyPreview(input: PreviewInput): PreviewResult {
  const warnings: PreviewWarning[] = [];

  // 1. Shared payload — same call the publisher makes. Guarantees the
  // operator sees the same text parts and the same media placement
  // the publisher will write.
  const payload = prepareBlueskyThreadPayload({
    title: input.title,
    body: input.body,
    creative: input.creative
      ? {
          // Preview surfaces don't track creative ids; the shared
          // layer accepts null on this field.
          id: null,
          assetUrl: input.creative.assetUrl,
          sourceUrl: null,
          altText: input.creative.altText,
          creativeType: input.creative.sourceType ?? "image",
        }
      : null,
  });

  // 2. Empty-body fallback. Render a single empty part so the UI
  // doesn't crash; the operator's autosave still has the body.
  if (payload.kind === "empty_body") {
    return {
      platform: "bluesky",
      parts: [
        {
          index: 1,
          total: 1,
          text: "",
          length: 0,
          budget: BLUESKY_POST_BUDGET,
          truncated: false,
          showsCreative: false,
        },
      ],
      identity: input.identity,
      creative: input.creative,
      warnings: [],
      totalLength: 0,
      perPartBudget: BLUESKY_POST_BUDGET,
      unit: "graphemes",
      titleVisible: false,
      format: "single_post",
      transformationNotes: [],
      creativeDirection: input.platformNativeDraft?.creativeDirection,
    };
  }

  // 3. Translate shared parts → preview parts.
  const parts: PreviewPart[] = payload.parts.map((p) => ({
    index: p.index,
    total: p.total,
    text: p.text,
    length: p.graphemeCount,
    budget: BLUESKY_POST_BUDGET,
    truncated: false,
    showsCreative: p.attachMedia,
  }));

  // 4. Title ignored warning (same signal as the publisher).
  if (payload.titleIgnored) {
    pushWarning(warnings, {
      kind: "title_ignored_by_platform",
      message:
        "Bluesky has no post title — only the body will appear in the feed.",
    });
  }

  // 5. Creative-block warnings — mirror the publisher's blocked
  // reason codes deterministically. The shared layer produced the
  // decision; the preview surfaces it as an operator warning while
  // still rendering the text parts.
  if (payload.creativeBlocked?.reasonCode === "creative_missing_asset") {
    pushWarning(warnings, {
      kind: "creative_missing_asset",
      message:
        "Image will NOT be attached: creative is missing asset_url / source_url. Publishing is blocked until this is fixed.",
      partIndex: 1,
    });
  } else if (
    payload.creativeBlocked?.reasonCode === "creative_missing_alt_text"
  ) {
    // Two complementary signals so the existing alt_text_missing
    // affordance still appears AND the publisher's exact reason code
    // is also surfaced.
    pushWarning(warnings, {
      kind: "alt_text_missing",
      message: "Image has no alt text — required for accessibility.",
      partIndex: 1,
    });
    pushWarning(warnings, {
      kind: "creative_blocked_missing_alt_text",
      message:
        "Image will NOT be attached: alt text is required for Bluesky. Publishing is blocked until this is fixed.",
      partIndex: 1,
    });
  }

  // 6. Social-quality warnings — these only depend on the stripped
  // body, so we recompute from the rendered parts. Using the joined
  // part text keeps the densities consistent with what the operator
  // sees.
  const joinedText = parts.map((p) => p.text).join(" ");
  const density = hashtagDensity(joinedText);
  if (density >= 1.5) {
    pushWarning(warnings, {
      kind: "high_hashtag_density",
      message:
        "Hashtags read as foreign on Bluesky. Drop them unless they're load-bearing.",
    });
  }
  if (looksPromotional(joinedText)) {
    pushWarning(warnings, {
      kind: "too_promotional",
      message:
        "Phrases like 'this is huge' / 'must read' feel like X-style bait on Bluesky.",
    });
  }
  if (emojiCount(joinedText) > 3) {
    pushWarning(warnings, {
      kind: "emoji_dense",
      message: "Bluesky leans sparse on emoji — consider trimming.",
    });
  }
  if (parts.length > 8) {
    pushWarning(warnings, {
      kind: "thread_too_long",
      message:
        "Threads longer than 8 posts feel desperate on Bluesky. Consider a single calm post.",
    });
  }
  if (parts.length > 1 && parts[0].length < 40) {
    pushWarning(warnings, {
      kind: "first_post_too_short",
      message:
        "First post is very short — Bluesky readers often see only the first card.",
      partIndex: 1,
    });
  }

  // Total length sums the parts (including any suffix), since that's
  // the actual operator-visible length.
  const totalLength = parts.reduce((n, p) => n + p.length, 0);
  // Defensive: never report a thread without a usable budget; the
  // helper used to count graphemes on raw body only.
  void graphemeCount;

  return {
    platform: "bluesky",
    parts,
    identity: input.identity,
    creative: input.creative,
    warnings,
    totalLength,
    perPartBudget: BLUESKY_POST_BUDGET,
    unit: "graphemes",
    titleVisible: false,
    format: parts.length === 1 ? "single_post" : "thread",
    transformationNotes: payload.transformationNotes,
    creativeDirection: input.platformNativeDraft?.creativeDirection,
  };
}
