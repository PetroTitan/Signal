/**
 * Phase F4 — canonical post.
 *
 * One internal representation of a piece of content. Each platform
 * adapter consumes the same canonical post and produces a
 * platform-shaped payload via a transformer.
 *
 * IMPORTANT: this type is intentionally narrow. It is not a CMS
 * schema. It is the union of fields the three tier-1 platforms
 * (dev.to, Hashnode, Bluesky) — plus Reddit — actually need.
 */

import type { PublishPlatform } from "./publishing-types";

export interface CanonicalPost {
  /** Stable id within Signal — usually the weekly_plan_items row id. */
  id: string;
  /** Headline / post title. Bluesky ignores this (text-only). */
  title: string | null;
  /** Body in markdown. The single source of truth for prose. */
  bodyMarkdown: string | null;
  /** Short plain-text summary; falls back to first paragraph of body. */
  summary: string | null;
  /** Tags as bare words (no '#'). Adapters may trim, lowercase, slug. */
  tags: string[];
  /** Canonical URL on the operator's own site (for SEO). */
  canonicalUrl: string | null;
  /** Optional cover image URL for blog-style platforms. */
  coverImageUrl: string | null;
  /** Optional link the post points at (Reddit link-post / dev.to "link" style). */
  linkUrl: string | null;
  /** Optional series / publication hint (Hashnode). */
  series: string | null;
}

export interface CanonicalPostTarget {
  /** Where this canonical post should be published. */
  platform: PublishPlatform;
  /** Platform-specific routing target — subreddit, Hashnode publicationId, etc. */
  target: string | null;
}

/**
 * Build a CanonicalPost from a PublishRequest. The legacy PublishRequest
 * carries all the same fields under shorter names — this helper just
 * normalizes them so adapters can consume one consistent shape.
 */
export function canonicalPostFromRequest(req: {
  planItemId: string;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  summary?: string | null;
  tags?: string[];
  canonicalUrl?: string | null;
  coverImageUrl?: string | null;
  series?: string | null;
}): CanonicalPost {
  return {
    id: req.planItemId,
    title: req.title,
    bodyMarkdown: req.body,
    summary: req.summary ?? null,
    tags: req.tags ?? [],
    canonicalUrl: req.canonicalUrl ?? null,
    coverImageUrl: req.coverImageUrl ?? null,
    linkUrl: req.linkUrl,
    series: req.series ?? null,
  };
}
