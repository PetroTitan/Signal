/**
 * Phase F2.5 (manual-publish fallback) — Reddit permalink parser.
 *
 * The operator pastes a permalink they got from their browser after
 * manually publishing on Reddit. We:
 *   1. Sanity-check the URL is on reddit.com.
 *   2. Extract the t3 id (the canonical "fullname" for a submission).
 *   3. Optionally check the subreddit segment matches the expected one.
 *
 * Accepted shapes:
 *   https://www.reddit.com/r/<sub>/comments/<id>/<slug>/
 *   https://reddit.com/r/<sub>/comments/<id>/
 *   https://old.reddit.com/r/<sub>/comments/<id>/<slug>/
 *   https://redd.it/<id>
 *
 * Returns null on anything that doesn't match — the operator sees a
 * structured rejection rather than a free-text store.
 */

import "server-only";

export interface ParsedRedditPermalink {
  rawUrl: string;
  /** Canonical URL with trailing slash stripped. */
  normalizedUrl: string;
  /** Reddit's t3 fullname for the post, e.g. "t3_abc123". */
  providerPostId: string;
  /** base36 post id without prefix, e.g. "abc123". */
  postId: string;
  /** Subreddit name without /r/ prefix; null for redd.it shortlinks. */
  subreddit: string | null;
}

const REDDIT_COMMENTS_RE =
  /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^\/]+)\/comments\/([a-z0-9]+)(?:\/[^\/?#]*)?\/?(?:[?#].*)?$/i;
const REDDIT_SHORTLINK_RE =
  /^https?:\/\/redd\.it\/([a-z0-9]+)\/?(?:[?#].*)?$/i;

export function parseRedditPermalink(raw: string): ParsedRedditPermalink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const commentsMatch = REDDIT_COMMENTS_RE.exec(trimmed);
  if (commentsMatch) {
    const [, sub, id] = commentsMatch;
    const normalized = `https://www.reddit.com/r/${sub}/comments/${id}/`;
    return {
      rawUrl: trimmed,
      normalizedUrl: normalized,
      providerPostId: `t3_${id}`,
      postId: id,
      subreddit: sub,
    };
  }

  const shortMatch = REDDIT_SHORTLINK_RE.exec(trimmed);
  if (shortMatch) {
    const [, id] = shortMatch;
    return {
      rawUrl: trimmed,
      normalizedUrl: `https://redd.it/${id}`,
      providerPostId: `t3_${id}`,
      postId: id,
      subreddit: null,
    };
  }

  return null;
}

/**
 * Operator-facing rejection message for an invalid permalink.
 */
export function permalinkRejectionDetail(raw: string): string {
  if (!raw || raw.trim().length === 0) {
    return "Paste the full Reddit permalink to the post you just published.";
  }
  return (
    "Could not parse a Reddit permalink. Expected one of:\n" +
    "  https://www.reddit.com/r/<sub>/comments/<id>/<slug>/\n" +
    "  https://redd.it/<id>\n" +
    `Got: ${raw.slice(0, 200)}`
  );
}
