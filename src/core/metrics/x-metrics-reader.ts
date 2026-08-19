import "server-only";
/**
 * Authenticated X metrics read.
 *
 * Unlike every other metric fetcher in this subsystem, X needs a
 * user-context token, so this module is the one place where the metrics
 * path touches OAuth. It does so on strict terms:
 *
 *   - READ ONLY. The single endpoint is GET /2/tweets. There is no code
 *     path from here to /2/tweets (POST), /2/media/upload, or any other
 *     write.
 *   - It reuses `ensureFreshXAccessToken`, the same refresh helper the
 *     publishing scheduler uses, so token rotation semantics cannot
 *     drift between publishing and measurement.
 *   - It NEVER triggers a reauthorization flow and never changes stored
 *     scopes. A token that needs reauth yields `unavailable` with an
 *     operator-facing reason; recovering it is a human action.
 *   - It never logs, returns, or embeds a token value.
 *
 * Cost: reading our own posts by id through GET /2/tweets is billed as a
 * Post lookup. Batching to 100 ids per request is therefore about
 * request count, not spend — spend is per resource returned either way,
 * and the backfill's gate is what bounds it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";
import { resolveXAccessTokenForMetrics } from "./x-token-access";
import {
  metricSource,
  rateLimitedResult,
  unavailableResult,
  type MetricsResult,
} from "./metrics-provider";
import {
  X_TWEET_FIELDS,
  classifyXReadError,
  isXPostId,
  parseXLookupResponse,
  readXRateLimit,
  type XRateLimitSnapshot,
} from "./x-metrics";

const X_API_BASE = "https://api.twitter.com";
const METRICS_UA = "SignalPublishing/1.0 (metrics; +https://signal.app)";
const REQUEST_TIMEOUT_MS = 15_000;

export interface XMetricsContext {
  db: SupabaseClient;
  workspaceId: string;
  /** growth_accounts.id — the identity that published the post. */
  accountId: string | null;
  nowIso?: string;
}

export interface XReadDiagnostics {
  rateLimit: XRateLimitSnapshot | null;
}

/**
 * Read `public_metrics` for one X post.
 *
 * Returns `unavailable` (never a fabricated zero) for every condition in
 * which we did not receive counters: no connection, no token, refused
 * token, throttling, billing, a deleted post, or a malformed payload.
 * Each carries a distinct operator-facing reason so the sweep report can
 * say which one happened.
 */
export async function fetchXMetrics(
  externalPostId: string | null,
  ctx: XMetricsContext | null,
): Promise<MetricsResult> {
  const source = metricSource("x");

  if (!isXPostId(externalPostId)) {
    return unavailableResult(
      "x",
      externalPostId,
      "No X post id recorded for this publication, so it cannot be looked up.",
    );
  }
  if (!ctx || !ctx.accountId) {
    return unavailableResult(
      "x",
      externalPostId,
      "X metrics need the publishing identity's connection; no account was " +
        "resolved for this publication.",
    );
  }

  const token = await resolveXAccessTokenForMetrics(ctx);
  if (!token.ok) {
    return unavailableResult("x", externalPostId, token.reason);
  }

  const url =
    `${X_API_BASE}/2/tweets?ids=${encodeURIComponent(externalPostId)}` +
    `&tweet.fields=${encodeURIComponent(X_TWEET_FIELDS)}`;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "User-Agent": METRICS_UA,
        Accept: "application/json",
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return unavailableResult("x", externalPostId, "X metrics request timed out.");
    }
    return unavailableResult(
      "x",
      externalPostId,
      err instanceof Error ? `X metrics request failed: ${err.message}` : "X metrics request failed.",
    );
  }

  const rateLimit = readXRateLimit(resp.headers);

  if (!resp.ok) {
    const body = await safeJson(resp);
    const classified = classifyXReadError(resp.status, body);
    if (classified.kind === "rate_limited") {
      return {
        ...rateLimitedResult("x", externalPostId, rateLimit.resetAt),
        error: classified.message,
      };
    }
    return unavailableResult("x", externalPostId, classified.message);
  }

  const payload = await safeJson(resp);
  const parsed = parseXLookupResponse(payload);

  if (parsed.malformed) {
    return unavailableResult(
      "x",
      externalPostId,
      "X returned a response that did not match the documented v2 shape.",
    );
  }
  if (parsed.missing.has(externalPostId)) {
    return unavailableResult(
      "x",
      externalPostId,
      "X reports this post as unavailable — it may have been deleted or is " +
        "not visible to the connected account.",
    );
  }

  const tweet = parsed.found.get(externalPostId);
  if (!tweet) {
    return unavailableResult(
      "x",
      externalPostId,
      "X returned no data for this post id.",
    );
  }
  if (Object.keys(tweet.metrics).length === 0) {
    // We saw the post but got no counters. That is unavailable, not zero.
    return unavailableResult(
      "x",
      externalPostId,
      "X returned the post without any public_metrics counters.",
    );
  }

  return {
    status: "connected",
    source,
    externalPostId,
    metrics: tweet.metrics,
    providerPublishedAt: tweet.createdAt,
  };
}

async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
