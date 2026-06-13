import "server-only";
/**
 * Phase C3.2/C3.3/C3.4 — verified metric fetchers.
 *
 * Reads ONLY official, public provider endpoints and returns the exact
 * counts they report — no estimates, no scraping of rendered pages, no
 * derived analytics:
 *   - Bluesky: public app-view `app.bsky.feed.getPosts` (no auth) →
 *     likeCount / repostCount / replyCount / quoteCount.
 *   - Reddit:  the post's official `.json` (no auth) → score +
 *     num_comments.
 *   - X:       requires an elevated/paid tier → `unavailable` (we do
 *     NOT touch X OAuth/adapters here).
 *   - others:  `unsupported`.
 *
 * Does NOT touch OAuth login, provider publish adapters, or stored
 * tokens — these are read-only public lookups.
 */

import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";
import {
  coerceCount,
  metricCapability,
  metricSource,
  unavailableReason,
  unavailableResult,
  unsupportedResult,
  type MetricsResult,
  type VerifiedMetrics,
} from "./metrics-provider";

const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app";
const DEVTO_API_BASE = "https://dev.to/api";
const METRICS_UA = "SignalPublishing/1.0 (metrics; +https://signal.app)";

export interface FetchMetricsInput {
  platform: string;
  /** Provider post id — Bluesky at-uri, X tweet id, etc. */
  externalPostId: string | null;
  /** Public permalink — used for the Reddit `.json` lookup. */
  permalink: string | null;
}

export async function fetchVerifiedMetrics(
  input: FetchMetricsInput,
): Promise<MetricsResult> {
  const capability = metricCapability(input.platform);
  if (capability === "unsupported") return unsupportedResult(input.platform);
  if (capability === "unavailable") {
    return unavailableResult(
      input.platform,
      input.externalPostId,
      unavailableReason(input.platform),
    );
  }
  // capability === "verified"
  try {
    if (input.platform === "bluesky") return await fetchBlueskyMetrics(input.externalPostId);
    if (input.platform === "reddit") return await fetchRedditMetrics(input.permalink);
    if (input.platform === "devto") return await fetchDevtoMetrics(input.externalPostId);
    return unsupportedResult(input.platform);
  } catch (err) {
    return unavailableResult(
      input.platform,
      input.externalPostId,
      err instanceof Error ? err.message : "metrics fetch failed",
    );
  }
}

async function fetchBlueskyMetrics(atUri: string | null): Promise<MetricsResult> {
  const source = metricSource("bluesky");
  if (!atUri || !atUri.startsWith("at://")) {
    return { status: "unavailable", source, externalPostId: atUri, metrics: {}, error: "missing at-uri" };
  }
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`,
      { method: "GET", headers: { "User-Agent": METRICS_UA }, timeoutMs: 15_000 },
    );
  } catch (err) {
    if (isTimeoutError(err)) throw new Error("Bluesky metrics timed out");
    throw err;
  }
  if (!resp.ok) {
    return { status: "unavailable", source, externalPostId: atUri, metrics: {}, error: `getPosts ${resp.status}` };
  }
  const json = (await resp.json()) as {
    posts?: Array<{ likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }>;
  };
  const post = json.posts?.[0];
  if (!post) {
    return { status: "unavailable", source, externalPostId: atUri, metrics: {}, error: "post not found" };
  }
  const metrics: VerifiedMetrics = {
    likes: coerceCount(post.likeCount),
    reposts: coerceCount(post.repostCount),
    replies: coerceCount(post.replyCount),
    quotes: coerceCount(post.quoteCount),
  };
  return { status: "connected", source, externalPostId: atUri, metrics };
}

async function fetchRedditMetrics(permalink: string | null): Promise<MetricsResult> {
  const source = metricSource("reddit");
  if (!permalink) {
    return { status: "unavailable", source, externalPostId: null, metrics: {}, error: "missing permalink" };
  }
  // Normalize to the official JSON endpoint of the post.
  const base = permalink.replace(/\/+$/, "");
  const url = `${base}.json`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: { "User-Agent": METRICS_UA },
      timeoutMs: 15_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error("Reddit metrics timed out");
    throw err;
  }
  if (!resp.ok) {
    return { status: "unavailable", source, externalPostId: permalink, metrics: {}, error: `reddit ${resp.status}` };
  }
  const json = (await resp.json()) as Array<{
    data?: { children?: Array<{ data?: { score?: number; num_comments?: number; name?: string } }> };
  }>;
  const data = json?.[0]?.data?.children?.[0]?.data;
  if (!data) {
    return { status: "unavailable", source, externalPostId: permalink, metrics: {}, error: "post not found" };
  }
  const metrics: VerifiedMetrics = {
    score: coerceCount(data.score),
    comments: coerceCount(data.num_comments),
  };
  return { status: "connected", source, externalPostId: data.name ?? permalink, metrics };
}

/**
 * dev.to public article endpoint (no auth):
 *   GET https://dev.to/api/articles/{id}
 *   → public_reactions_count + comments_count.
 * `page_views_count` is author-only (requires the API key) and is NOT
 * exposed publicly, so we never surface a view count here rather than
 * fabricate one. The article id is the provider_post_id the publisher
 * stored at publish time.
 */
async function fetchDevtoMetrics(articleId: string | null): Promise<MetricsResult> {
  const source = metricSource("devto");
  if (!articleId || !/^\d+$/.test(articleId.trim())) {
    return { status: "unavailable", source, externalPostId: articleId, metrics: {}, error: "missing article id" };
  }
  let resp: Response;
  try {
    resp = await fetchWithTimeout(`${DEVTO_API_BASE}/articles/${articleId.trim()}`, {
      method: "GET",
      headers: { "User-Agent": METRICS_UA, Accept: "application/json" },
      timeoutMs: 15_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error("dev.to metrics timed out");
    throw err;
  }
  if (!resp.ok) {
    return { status: "unavailable", source, externalPostId: articleId, metrics: {}, error: `devto ${resp.status}` };
  }
  const json = (await resp.json()) as {
    public_reactions_count?: number;
    positive_reactions_count?: number;
    comments_count?: number;
  };
  const metrics: VerifiedMetrics = {
    reactions: coerceCount(json.public_reactions_count ?? json.positive_reactions_count),
    comments: coerceCount(json.comments_count),
  };
  return { status: "connected", source, externalPostId: articleId, metrics };
}
