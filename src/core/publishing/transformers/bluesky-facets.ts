/**
 * Phase F4.2 — Bluesky rich-text facets.
 *
 * Bluesky's app.bsky.feed.post records support a `facets` array that
 * marks byte-ranges within `text` as links, mentions, or tags. Without
 * facets, URLs inside the text render as plain text (not clickable),
 * which makes the post less useful for blog/announcement traffic.
 *
 * Reference:
 *   https://docs.bsky.app/docs/advanced-guides/post-richtext
 *
 * What we do:
 *   - scan the text for http/https URLs
 *   - compute UTF-8 byte ranges (not character ranges — Bluesky
 *     requires bytes)
 *   - emit one facet per URL with a single `app.bsky.richtext.facet#link`
 *     feature
 *
 * What we do NOT do:
 *   - mentions (would require resolving the handle → did)
 *   - hashtags (Bluesky doesn't auto-index them yet)
 *   - shortening — full URLs are kept verbatim
 */

const URL_RE = /\b(https?:\/\/[^\s<>"')\]]+)/g;

export interface BlueskyFacetByteRange {
  byteStart: number;
  byteEnd: number;
}

export interface BlueskyLinkFacet {
  index: BlueskyFacetByteRange;
  features: Array<{
    $type: "app.bsky.richtext.facet#link";
    uri: string;
  }>;
}

/**
 * Extract clickable-link facets from a plain-text Bluesky post.
 *
 * Returns an array sorted by byteStart ascending. Empty when no URLs
 * are present — callers can omit the `facets` field entirely.
 */
export function extractFacets(text: string): BlueskyLinkFacet[] {
  const facets: BlueskyLinkFacet[] = [];
  const encoder = new TextEncoder();
  // Walk the string in code-unit order; convert each match's character
  // span into a byte span by encoding the prefix.
  for (const match of text.matchAll(URL_RE)) {
    const url = match[1];
    if (!url) continue;
    const charStart = match.index ?? 0;
    const prefix = text.slice(0, charStart);
    const matched = text.slice(charStart, charStart + url.length);
    const byteStart = encoder.encode(prefix).byteLength;
    const byteEnd = byteStart + encoder.encode(matched).byteLength;
    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: "app.bsky.richtext.facet#link",
          uri: stripTrailingPunctuation(url),
        },
      ],
    });
  }
  return facets;
}

/**
 * URLs in prose often end with stray punctuation: "see https://foo.com.".
 * The regex above grabs the period as part of the URL; strip it back
 * off so the link target itself is clean. Returns the trimmed URL.
 */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/g, "");
}
