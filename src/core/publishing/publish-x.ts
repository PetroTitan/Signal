import "server-only";
/**
 * X (formerly Twitter) publisher.
 *
 * Pure HTTP layer for X automated publishing. Posts a SINGLE tweet
 * via the official v2 endpoint:
 *
 *   POST https://api.twitter.com/2/tweets
 *   Authorization: Bearer <user-context access token>
 *   Content-Type: application/json
 *   Body: { text, media?: { media_ids: [<id>] } }
 *
 * Scope (v1 — Phase F9):
 *   - single-post intent only (new_post). Threads, replies, quotes,
 *     and DMs are explicitly NOT implemented.
 *   - 280-char hard limit enforced defensively (the platform-native
 *     X adapter already validates at approval time).
 *   - Optional single image attachment via a pre-uploaded `media_id`
 *     (Phase F9 commit 5 — the orchestrator handles upload; this
 *     publisher only consumes the id).
 *
 * Strict policy:
 *   - NEVER logs the access token.
 *   - NEVER retries on 401 — the scheduler's refresh helper runs
 *     upstream; a 401 here means the token was just rotated and
 *     immediately invalidated (race) or X invalidated it mid-call.
 *     Surface as `x_token_invalid` so the operator sees a clear
 *     reason; the next tick's refresh will recover.
 *   - NEVER silently downgrades. The pre-attempt body-length check
 *     fails with `body_too_long`; provider errors fail with the X
 *     prefix reason codes.
 */

import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";
import { publishFail, publishOk } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

const X_TWEETS_URL = "https://api.twitter.com/2/tweets";

/**
 * Per-post hard limit. The platform-native adapter
 * (`adapters/x/index.ts`) uses 280 for single posts and reserves 5
 * chars for the "(N/M)" suffix in thread mode. The publisher honors
 * the strict single-post limit because we do not produce threads in
 * v1.
 */
const X_HARD_LIMIT = 280;

export interface PublishXInput {
  request: PublishRequest;
  /**
   * Decrypted OAuth 2.0 user-context access token. Caller is
   * responsible for refresh + disposal — the publisher holds the
   * value only for the duration of the single fetch call.
   */
  accessToken: string;
  /**
   * `platform_connections.handle` for this identity. Used to build
   * the canonical permalink. When null, the publisher falls back to
   * the id-only permalink `https://x.com/i/status/<id>` which X
   * resolves to the correct user.
   */
  username: string | null;
  /**
   * Optional pre-uploaded X media id. When present, attached to the
   * tweet via `media: { media_ids: [<id>] }`. The upload itself
   * lives in the orchestrator (commit 5); this publisher never
   * uploads media.
   */
  mediaId?: string | null;
}

interface XTweetCreateResponse {
  data?: {
    id?: unknown;
    text?: unknown;
  };
}

interface XApiErrorBody {
  detail?: unknown;
  title?: unknown;
  errors?: Array<{ message?: unknown }> | unknown;
}

/**
 * Build the operator-facing permalink. X accepts both
 * `https://x.com/...` and `https://twitter.com/...`; we use the
 * current canonical (`x.com`).
 */
function buildXPermalink(
  username: string | null,
  tweetId: string,
): string {
  if (username && username.trim().length > 0) {
    return `https://x.com/${username.trim().replace(/^@/, "")}/status/${tweetId}`;
  }
  return `https://x.com/i/status/${tweetId}`;
}

export async function publishToX(
  input: PublishXInput,
): Promise<PublishOutcome> {
  const { request, accessToken, username, mediaId } = input;

  if (!accessToken || accessToken.trim().length === 0) {
    return publishFail(
      "x_token_missing",
      "X publish requires a decrypted access token.",
      { endpoint: "tweets" },
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "X posts require body text.", {
      endpoint: "tweets",
    });
  }

  const text = request.body.trim();
  if (text.length > X_HARD_LIMIT) {
    // Defensive: the platform-native adapter blocks at approval. If
    // an item slips through, fail fast rather than letting X 400.
    return publishFail(
      "body_too_long",
      `X post body is ${text.length} chars; per-post limit is ${X_HARD_LIMIT}.`,
      { endpoint: "tweets", char_count: text.length, limit: X_HARD_LIMIT },
    );
  }

  // Build the JSON body. Media attachment is opt-in via mediaId.
  const body: Record<string, unknown> = { text };
  if (mediaId && mediaId.trim().length > 0) {
    body.media = { media_ids: [mediaId] };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(X_TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return publishFail(
        "x_network_error",
        "X didn't respond in time (30s).",
        { endpoint: "tweets" },
      );
    }
    return publishFail(
      "x_network_error",
      `X network error: ${err instanceof Error ? err.message : "unknown"}`,
      { endpoint: "tweets" },
    );
  }

  if (response.status === 401) {
    return publishFail(
      "x_token_invalid",
      "X returned 401; the access token is invalid or revoked. Reconnect from the identity card.",
      { http_status: 401, endpoint: "tweets" },
    );
  }
  if (response.status === 403) {
    const detail = await safeReadXErrorDetail(response);
    return publishFail(
      "x_token_invalid",
      `X returned 403; the token lacks the required scope or the action is forbidden. ${detail}`,
      { http_status: 403, endpoint: "tweets" },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "x_rate_limited",
      "X asked us to slow down.",
      { http_status: 429, endpoint: "tweets" },
    );
  }
  if (response.status >= 500 && response.status < 600) {
    return publishFail(
      "x_provider_unavailable",
      `X returned HTTP ${response.status}; the provider is unavailable. Try again.`,
      { http_status: response.status, endpoint: "tweets" },
    );
  }
  if (response.status >= 400 && response.status < 500) {
    const detail = await safeReadXErrorDetail(response);
    return publishFail(
      "x_validation_error",
      `X validation: ${detail || `HTTP ${response.status}`}`,
      { http_status: response.status, endpoint: "tweets" },
    );
  }
  if (!response.ok) {
    return publishFail(
      "x_api_error",
      `X returned HTTP ${response.status}.`,
      { http_status: response.status, endpoint: "tweets" },
    );
  }

  let json: XTweetCreateResponse;
  try {
    json = (await response.json()) as XTweetCreateResponse;
  } catch (err) {
    return publishFail(
      "x_api_error",
      `X response was not JSON: ${err instanceof Error ? err.message : "unknown"}`,
      { endpoint: "tweets" },
    );
  }
  const id = json.data?.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return publishFail(
      "x_api_error",
      "X response missing data.id.",
      { endpoint: "tweets" },
    );
  }

  const permalink = buildXPermalink(username, id);

  return publishOk({
    externalId: id,
    externalUrl: permalink,
    metadata: {
      endpoint: "tweets",
      mode: mediaId ? "automated_media" : "automated",
      media_mode: mediaId ? "x_image" : "text_only",
      media_url_present: !!mediaId,
      x_media_id_present: !!mediaId,
      ...(mediaId ? { x_media_id: mediaId } : {}),
    },
  });
}

/**
 * Extract a short, log-safe X error detail from the response body.
 * X's v2 error shape is one of:
 *   { detail: "...", title: "...", type: "https://..." }
 *   { errors: [{ message: "..." }] }
 * We trim aggressively so log lines stay readable and never include
 * the request body or auth header.
 */
async function safeReadXErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as XApiErrorBody;
      if (typeof parsed.detail === "string") {
        return parsed.detail.slice(0, 200);
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        const first = parsed.errors[0] as { message?: unknown };
        if (typeof first.message === "string") {
          return first.message.slice(0, 200);
        }
      }
      if (typeof parsed.title === "string") {
        return parsed.title.slice(0, 200);
      }
    } catch {
      // not JSON — return the trimmed text
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
