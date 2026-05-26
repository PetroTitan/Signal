/**
 * Shared Bluesky payload preparation.
 *
 * Goal — eliminate preview/publish divergence
 * -------------------------------------------
 * Before this module, the platform preview rendered with one splitter
 * (`splitIntoThreadParts`, grapheme-aware, budget 300, no thread
 * suffix) while the publisher rendered with another (`splitIntoChunks`,
 * UTF-16 length, budget 290, " (N/M)" suffix). The preview also did
 * its own `input.creative !== null` check; the publisher had no
 * creative path at all (PR 1 added one, with its own validation in
 * the scheduler). Both halves of the system could disagree about
 * thread shape, creative attachment, and blocked reasons.
 *
 * This module is the ONE place that:
 *   1. strips markdown for Bluesky (one rule set);
 *   2. validates the optional creative (one rule set);
 *   3. splits the body into thread parts (grapheme-aware, single
 *      budget, " (N/M)" suffix when threaded);
 *   4. decides which part gets the media embed (always part 1);
 *   5. produces the structured payload that both the preview renderer
 *      and the publisher consume.
 *
 * Pure module — no I/O, no Supabase, no React, no fetch. The
 * publisher fetches + uploads the image bytes separately; this layer
 * only carries the metadata.
 */

import {
  graphemeCount,
  splitIntoThreadParts,
  stripMarkdownForSocial,
} from "@/core/platform-preview/preview-renderer";

/** AT Proto's per-post grapheme cap. */
export const BLUESKY_POST_BUDGET = 300;

/**
 * Reserved budget for the " (N/M)" thread-position suffix when N > 1.
 *
 * Worst case is " (99/99)" = 8 graphemes. We always reserve 8 when
 * threading, even for small N — the 2-grapheme waste on " (1/2)" is
 * cheaper than two-pass re-splitting. Single posts pay nothing.
 */
const SUFFIX_RESERVED_GRAPHEMES = 8;

// =====================================================================
// Input / output shapes
// =====================================================================

export interface BlueskyPayloadCreativeInput {
  /** Creative row id when known (publish path). `null` is accepted
   *  for surfaces that don't track DB ids (preview rendering). */
  id: string | null;
  /** Direct fetchable URL (Supabase storage / CDN). Falls back to
   *  `sourceUrl` when null. */
  assetUrl: string | null;
  /** Fallback URL for manual-url creatives. */
  sourceUrl: string | null;
  /** Accessibility alt text. Must be non-empty post-trim for Bluesky. */
  altText: string | null;
  /** "image" today; widened to "video"/etc. when those land. */
  creativeType: string;
}

export interface BlueskyPayloadInput {
  /** Plan-item title. Bluesky has no post-title concept; flagged
   *  via `titleIgnored` when non-empty. */
  title: string | null;
  /** Raw body (markdown allowed; this module strips it). */
  body: string;
  /** Optional creative to embed on the first post. */
  creative: BlueskyPayloadCreativeInput | null;
}

export interface BlueskyPayloadPart {
  /** 1-based index. Single posts are [1, 1]. */
  index: number;
  /** Total parts in the thread. */
  total: number;
  /** Final visible text (markdown-stripped, suffix-appended when
   *  threaded). What the publisher writes into the record AND what
   *  the preview shows. */
  text: string;
  /** Grapheme count of `text`. Useful for the preview's "X/300" UI. */
  graphemeCount: number;
  /** True ONLY for part 1 when a valid creative is attached. */
  attachMedia: boolean;
}

export interface BlueskyPayloadMedia {
  /** Creative row id when known. */
  creativeId: string | null;
  /** Resolved fetch URL (assetUrl preferred, sourceUrl fallback). */
  imageUrl: string;
  /** Validated non-empty alt text. */
  altText: string;
  /** Passthrough creative_type. */
  creativeType: string;
}

export type BlueskyPayloadCreativeBlockReason =
  | "creative_missing_asset"
  | "creative_missing_alt_text";

export interface BlueskyPayloadCreativeBlock {
  reasonCode: BlueskyPayloadCreativeBlockReason;
  reasonDetail: string;
}

/**
 * Result shape consumed by both callers.
 *
 *   - `empty_body`: the body is missing or whitespace-only. Both
 *     preview and publisher refuse — no parts, no media.
 *   - `prepared`: parts are always set (at least one). `media` is
 *     set when a creative is attached AND valid. `creativeBlocked`
 *     is set when a creative is attached BUT invalid; the publisher
 *     converts this into `publishBlocked(reasonCode)`; the preview
 *     surfaces the same reason as a warning + suppresses media on
 *     the rendered parts.
 */
export type BlueskyPayloadResult =
  | { kind: "empty_body"; reasonDetail: string }
  | {
      kind: "prepared";
      parts: BlueskyPayloadPart[];
      media: BlueskyPayloadMedia | null;
      creativeBlocked: BlueskyPayloadCreativeBlock | null;
      titleIgnored: boolean;
      transformationNotes: string[];
    };

// =====================================================================
// Pure helpers
// =====================================================================

/**
 * Validate a creative input without preparing the full payload. Used
 * by the publisher's pre-PR1 resolver (`resolve-publish-creative.ts`)
 * AND by the shared payload preparer — both sites apply the same
 * rules so preview and publish never disagree.
 *
 * Returns `null` when the creative is absent OR fully populated.
 * Returns a `BlueskyPayloadCreativeBlock` when an attached creative
 * is missing the URL or alt text Bluesky requires.
 */
export function validateBlueskyCreative(
  creative: BlueskyPayloadCreativeInput | null,
): BlueskyPayloadCreativeBlock | null {
  if (!creative) return null;
  const url = (creative.assetUrl ?? creative.sourceUrl ?? "").trim();
  if (url.length === 0) {
    return {
      reasonCode: "creative_missing_asset",
      reasonDetail:
        "Approved creative is missing asset_url / source_url. Re-upload the image or supply a public URL before publishing.",
    };
  }
  const alt = creative.altText?.trim() ?? "";
  if (alt.length === 0) {
    return {
      reasonCode: "creative_missing_alt_text",
      reasonDetail:
        "Approved creative is missing alt text. Add a one-line description so the image is accessible before publishing.",
    };
  }
  return null;
}

function buildMedia(
  creative: BlueskyPayloadCreativeInput,
): BlueskyPayloadMedia {
  // Validation already ran; both fields are guaranteed non-empty.
  const imageUrl = (creative.assetUrl ?? creative.sourceUrl)!;
  const altText = creative.altText!.trim();
  return {
    creativeId: creative.id,
    imageUrl,
    altText,
    creativeType: creative.creativeType,
  };
}

/**
 * Append " (N/M)" to each thread chunk when there is more than one
 * chunk. Reserves SUFFIX_RESERVED_GRAPHEMES at split time so the
 * final per-part length stays ≤ BLUESKY_POST_BUDGET.
 */
function appendSuffixes(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  const total = chunks.length;
  return chunks.map((chunk, idx) => `${chunk} (${idx + 1}/${total})`);
}

// =====================================================================
// prepareBlueskyThreadPayload — the canonical entry point
// =====================================================================

export function prepareBlueskyThreadPayload(
  input: BlueskyPayloadInput,
): BlueskyPayloadResult {
  // Empty body → refuse symmetrically. Neither preview nor publisher
  // can do anything meaningful with whitespace.
  if (!input.body || input.body.trim().length === 0) {
    return {
      kind: "empty_body",
      reasonDetail: "Bluesky posts need body text.",
    };
  }

  const transformationNotes: string[] = [];

  // 1. Markdown strip — uses the preview's existing helper so the two
  // call sites are guaranteed identical.
  const stripped = stripMarkdownForSocial(input.body).trim();
  if (stripped !== input.body.trim()) {
    transformationNotes.push("Stripped Markdown.");
  }

  if (stripped.length === 0) {
    // Body was markdown-only (e.g., "```\n```"). Same refusal.
    return {
      kind: "empty_body",
      reasonDetail: "Bluesky posts need body text.",
    };
  }

  // 2. Creative validation.
  const creativeBlocked = validateBlueskyCreative(input.creative);
  const media: BlueskyPayloadMedia | null =
    input.creative && !creativeBlocked ? buildMedia(input.creative) : null;

  // 3. Split into thread parts. Reserve suffix room when threading is
  // likely; if a single chunk fits without the suffix, we use the
  // full budget. Two-pass keeps the common case (single post) tight.
  const total = graphemeCount(stripped);
  let chunks: string[];
  if (total <= BLUESKY_POST_BUDGET) {
    chunks = [stripped];
  } else {
    chunks = splitIntoThreadParts(
      stripped,
      BLUESKY_POST_BUDGET - SUFFIX_RESERVED_GRAPHEMES,
    );
  }
  const withSuffixes = appendSuffixes(chunks);
  if (withSuffixes.length > 1) {
    transformationNotes.push(
      `Split into ${withSuffixes.length} thread parts (Bluesky single-post limit: ${BLUESKY_POST_BUDGET} graphemes).`,
    );
  }

  const parts: BlueskyPayloadPart[] = withSuffixes.map((text, i) => ({
    index: i + 1,
    total: withSuffixes.length,
    text,
    graphemeCount: graphemeCount(text),
    attachMedia: i === 0 && media !== null,
  }));

  const titleIgnored = (input.title?.trim().length ?? 0) > 0;
  if (titleIgnored) {
    transformationNotes.push(
      "Title ignored — Bluesky has no post-title concept.",
    );
  }

  return {
    kind: "prepared",
    parts,
    media,
    creativeBlocked,
    titleIgnored,
    transformationNotes,
  };
}
