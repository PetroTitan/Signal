/**
 * Phase F4 — Hashnode transformer.
 *
 * Maps a CanonicalPost onto the `PublishPostInput` shape expected by
 * the Hashnode GraphQL `publishPost` mutation.
 *
 * Reference: https://apidocs.hashnode.com/#mutation-publishPost
 *
 * Transformation rules:
 *   - title trimmed, max 250 chars (Hashnode soft limit)
 *   - subtitle = summary (when present)
 *   - contentMarkdown is the body markdown verbatim
 *   - tags are mapped to { slug, name } objects (lowercased, slug-safe)
 *   - originalArticleURL is the canonical URL on the operator's site
 *   - coverImageOptions.coverImageURL is the cover image
 *   - publicationId is REQUIRED — sourced from credentials
 *   - slug is derived from title (lowercased, alphanumeric, dashed)
 */

import type { CanonicalPost } from "../canonical-post";

const MAX_TITLE = 250;
const MAX_TAGS = 5;
const TAG_SLUG_RE = /[a-z0-9-]/g;

export interface HashnodeTag {
  slug: string;
  name: string;
}

export interface HashnodePublishInput {
  title: string;
  subtitle?: string;
  contentMarkdown: string;
  publicationId: string;
  slug?: string;
  tags?: HashnodeTag[];
  originalArticleURL?: string;
  coverImageOptions?: {
    coverImageURL?: string;
  };
}

export interface HashnodeTransformOptions {
  publicationId: string;
}

export function transformForHashnode(
  post: CanonicalPost,
  options: HashnodeTransformOptions,
): HashnodePublishInput {
  const title = (post.title ?? "").trim().slice(0, MAX_TITLE);
  const body = (post.bodyMarkdown ?? "").trim();
  const subtitle = (post.summary ?? "").trim() || undefined;
  const tags = normalizeHashnodeTags(post.tags);
  const slug = deriveSlug(title);

  return {
    title,
    contentMarkdown: body,
    publicationId: options.publicationId,
    ...(subtitle ? { subtitle } : {}),
    ...(slug ? { slug } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(post.canonicalUrl ? { originalArticleURL: post.canonicalUrl } : {}),
    ...(post.coverImageUrl
      ? { coverImageOptions: { coverImageURL: post.coverImageUrl } }
      : {}),
  };
}

function normalizeHashnodeTags(input: string[] | undefined): HashnodeTag[] {
  if (!input || input.length === 0) return [];
  const seen = new Set<string>();
  const out: HashnodeTag[] = [];
  for (const raw of input) {
    const name = String(raw).trim();
    if (!name) continue;
    const slug = name.toLowerCase().match(TAG_SLUG_RE)?.join("");
    if (!slug) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function deriveSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/**
 * The actual GraphQL operation string. Kept here so the publisher can
 * import it without duplicating the schema definition.
 */
export const HASHNODE_PUBLISH_POST_MUTATION = `
  mutation PublishPost($input: PublishPostInput!) {
    publishPost(input: $input) {
      post {
        id
        url
        slug
        publishedAt
      }
    }
  }
`;
