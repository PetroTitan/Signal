import "server-only";
/**
 * Phase F1 — Reddit publisher (text + link posts only).
 *
 * Calls the official Reddit OAuth `/api/submit` endpoint. Requires a
 * stored, encrypted access token, an active weekly contract, and an
 * execution_mode='live' workspace flag. The runner gates all of that
 * before invoking this module.
 *
 * NEVER:
 *   - posts comments / DMs / votes
 *   - touches /api/comment, /api/vote, /api/sendreplies, etc.
 *   - scrapes or bypasses rate limits
 */

import {
  publishFail,
  publishOk,
} from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

/**
 * Mandatory: Reddit's API requires a unique User-Agent with the
 * format `<platform>:<app-id>:<version> (by /u/<username>)`. Bare or
 * default UAs are rate-limited aggressively or denied.
 */
const REDDIT_USER_AGENT =
  "web:com.webmasterid.signal:v0.1 (by /u/Webmasterid-core)";

export interface PublishRedditInput {
  request: PublishRequest;
  /** Decrypted access token. Caller is responsible for decryption
   *  and disposing of the value after the call. */
  accessToken: string;
  /** Target subreddit, without `r/`. */
  subreddit: string;
}

/**
 * Build the form-encoded body for /api/submit.
 * Reddit endpoint reference:
 *   POST https://oauth.reddit.com/api/submit
 *   Content-Type: application/x-www-form-urlencoded
 *   Headers: Authorization: Bearer <token>, User-Agent: <UA>
 *
 * Body params we use:
 *   sr           = subreddit (no /r/ prefix)
 *   kind         = "self" or "link"
 *   title        = post title
 *   text         = selftext (for self posts)
 *   url          = link target (for link posts)
 *   sendreplies  = false (no inbox spam)
 *   api_type     = "json"
 *   resubmit     = false
 */
export function buildRedditSubmitBody(input: PublishRedditInput): URLSearchParams {
  const { request, subreddit } = input;
  const isLink = !!request.linkUrl;
  const params = new URLSearchParams();
  params.set("sr", subreddit);
  params.set("kind", isLink ? "link" : "self");
  params.set("title", request.title ?? "");
  if (isLink) {
    params.set("url", request.linkUrl ?? "");
  } else {
    params.set("text", request.body ?? "");
  }
  params.set("sendreplies", "false");
  params.set("resubmit", "false");
  params.set("api_type", "json");
  return params;
}

/**
 * Publish to Reddit. Returns a structured outcome; never throws raw
 * exceptions and never logs the token.
 */
export async function publishToReddit(
  input: PublishRedditInput,
): Promise<PublishOutcome> {
  const { request, accessToken, subreddit } = input;
  if (!request.title || request.title.trim().length === 0) {
    return publishFail("missing_title", "Reddit posts require a title.");
  }
  if (!request.linkUrl && (!request.body || request.body.trim().length === 0)) {
    return publishFail(
      "missing_body",
      "Text posts require a body; otherwise provide a link_url.",
    );
  }
  if (!subreddit || subreddit.trim().length === 0) {
    return publishFail(
      "missing_subreddit",
      "Reddit requires a target subreddit (without r/).",
    );
  }

  const body = buildRedditSubmitBody(input);
  let response: Response;
  try {
    response = await fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": REDDIT_USER_AGENT,
      },
      body: body.toString(),
    });
  } catch (err) {
    // P0.2 class C. POST /api/submit is a non-idempotent CREATE. The
    // request was dispatched and no response came back, so the post may
    // exist. Reporting this as a plain API error let the retry policy
    // treat it as transient and let the operator's "Try again" fire —
    // either of which could duplicate a live post.
    return publishFail(
      "publish_outcome_unknown",
      `Reddit: the submit request was sent but no response came back (${err instanceof Error ? err.message : "unknown"}). The post may or may not exist — check r/ before retrying.`,
      { http_status: 0, endpoint: "api/submit" },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "platform_unauthorized",
      `Reddit returned ${response.status}; the OAuth token may be revoked or missing scopes.`,
      { http_status: response.status },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "platform_rate_limited",
      "Reddit returned 429; backing off.",
      { http_status: 429 },
    );
  }
  if (!response.ok) {
    return publishFail(
      "platform_api_error",
      `Reddit returned HTTP ${response.status}.`,
      { http_status: response.status },
    );
  }

  // Reddit returns either { json: { errors: [...], data: { id, url, name } } }
  // or a stream-listing wrapper. We parse defensively.
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    // P0.2 class C. Reddit answered 2xx — the submit very likely
    // succeeded — but the body could not be parsed, so no permalink was
    // captured. Treating this as a plain failure invited a retry that
    // would post twice.
    return publishFail(
      "publish_outcome_unknown",
      `Reddit accepted the submit (HTTP ${response.status}) but the response body could not be read (${err instanceof Error ? err.message : "unknown"}). The post has probably been created — check r/ before retrying.`,
      { http_status: response.status, endpoint: "api/submit" },
    );
  }

  const data = (json as { json?: { data?: { id?: string; url?: string; name?: string }; errors?: Array<unknown> } }).json;
  if (data?.errors && data.errors.length > 0) {
    return publishFail(
      "platform_api_error",
      `Reddit errors: ${JSON.stringify(data.errors).slice(0, 200)}`,
      { errors: data.errors },
    );
  }

  const externalId = data?.data?.name ?? data?.data?.id ?? null;
  const externalUrl = data?.data?.url ?? null;
  return publishOk({
    externalId,
    externalUrl,
    metadata: { subreddit, kind: request.linkUrl ? "link" : "self" },
  });
}
