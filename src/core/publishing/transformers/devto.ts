/**
 * Phase F4 — dev.to transformer.
 *
 * Maps a CanonicalPost onto the request body shape expected by the
 * Forem `/api/articles` endpoint.
 *
 * Reference: https://developers.forem.com/api/v1#tag/articles/operation/createArticle
 *
 * Transformation rules:
 *   - title trimmed, max 128 chars (dev.to limit)
 *   - body uses markdown verbatim; we DO NOT rewrite or re-AI it
 *   - tags lowercased, alphanumeric+dashes only, max 4 (dev.to limit)
 *   - tags individually trimmed to 30 chars
 *   - canonical_url passed through when set
 *   - main_image is the optional cover image URL
 *   - published flag is intentionally exposed so the caller chooses
 *     "save as draft" vs "publish now" explicitly
 */

import type { CanonicalPost } from "../canonical-post";

const MAX_TITLE = 128;
const MAX_TAGS = 4;
const MAX_TAG_LEN = 30;
const TAG_ALLOWED = /[a-z0-9-]/g;

export interface DevtoPayload {
  article: {
    title: string;
    body_markdown: string;
    published: boolean;
    main_image?: string;
    canonical_url?: string;
    description?: string;
    tags?: string[];
    series?: string;
  };
}

export interface DevtoTransformOptions {
  /** True publishes immediately; false saves as a draft on dev.to. */
  published: boolean;
}

export function transformForDevto(
  post: CanonicalPost,
  options: DevtoTransformOptions,
): DevtoPayload {
  const title = (post.title ?? "").trim().slice(0, MAX_TITLE);
  const body = (post.bodyMarkdown ?? "").trim();
  const tags = normalizeTags(post.tags);
  const description = (post.summary ?? "").trim().slice(0, 280) || undefined;

  return {
    article: {
      title,
      body_markdown: body,
      published: options.published,
      ...(post.coverImageUrl ? { main_image: post.coverImageUrl } : {}),
      ...(post.canonicalUrl ? { canonical_url: post.canonicalUrl } : {}),
      ...(description ? { description } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(post.series ? { series: post.series } : {}),
    },
  };
}

function normalizeTags(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const clean = String(raw)
      .toLowerCase()
      .match(TAG_ALLOWED)
      ?.join("")
      .slice(0, MAX_TAG_LEN);
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
