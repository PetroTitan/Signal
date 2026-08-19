import "server-only";
/**
 * Fetch a provider's own feed so it can be reconciled against Signal's
 * record of what it published.
 *
 * Bluesky: `app.bsky.feed.getAuthorFeed` on the public AppView — free,
 * unauthenticated, and it returns the engagement counters inline, so one
 * request yields both the post list and its metrics.
 *
 * X: `GET /2/users/{id}/tweets`, which qualifies for Owned Reads at
 * $0.001 per resource — the cheapest documented way to read our own
 * timeline, and a batch endpoint, so it is preferred over per-id lookups.
 *
 * READ ONLY. Neither path can create, edit or delete anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";
import { coerceCount } from "@/core/metrics/metrics-provider";
import { classifyXReadError, parsePublicMetrics } from "@/core/metrics/x-metrics";
import { engagementCount } from "@/core/metrics/metrics-provider";
import type { ProviderPost } from "./reconciliation";

const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app";
const X_API_BASE = "https://api.twitter.com";
const UA = "SignalPublishing/1.0 (metrics; +https://signal.app)";
const TIMEOUT_MS = 20_000;

export type FeedResult =
  | { ok: true; posts: ProviderPost[]; truncated: boolean }
  | { ok: false; reason: string; rateLimited: boolean };

/** PURE — exported so feed mapping is testable without a network call. */
export function parseBlueskyAuthorFeed(
  payload: unknown,
  actorDid: string | null,
): ProviderPost[] {
  if (!payload || typeof payload !== "object") return [];
  const feed = (payload as { feed?: unknown }).feed;
  if (!Array.isArray(feed)) return [];

  const out: ProviderPost[] = [];
  for (const raw of feed) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { post?: unknown; reason?: unknown; reply?: unknown };
    const post = item.post as
      | {
          uri?: unknown;
          indexedAt?: unknown;
          author?: { did?: unknown };
          record?: { text?: unknown; reply?: unknown };
          likeCount?: unknown;
          repostCount?: unknown;
          replyCount?: unknown;
          quoteCount?: unknown;
          bookmarkCount?: unknown;
        }
      | undefined;
    if (!post || typeof post.uri !== "string") continue;

    // `reason` present means the feed item is a repost by the actor of
    // someone's content; the underlying post is not theirs to compare.
    const isRepost = item.reason != null;
    // A reply carries a `reply` key on the record.
    const isReply = Boolean(item.reply) || Boolean(post.record?.reply);
    // Defensive: the feed can include others' posts via reposts.
    const authoredByActor =
      actorDid == null || (post.author?.did as string | undefined) === actorDid;

    const metrics = {
      likes: coerceCount(post.likeCount),
      reposts: coerceCount(post.repostCount),
      replies: coerceCount(post.replyCount),
      quotes: coerceCount(post.quoteCount),
      bookmarks: coerceCount(post.bookmarkCount),
    };

    out.push({
      providerPostId: post.uri,
      platform: "bluesky",
      publishedAt:
        typeof post.indexedAt === "string" ? post.indexedAt : new Date(0).toISOString(),
      engagement: engagementCount(metrics),
      excerpt:
        typeof post.record?.text === "string"
          ? String(post.record.text).slice(0, 120)
          : null,
      isRepost: isRepost || !authoredByActor,
      isReply,
    });
  }
  return out;
}

/** Bluesky author feed, unauthenticated, cursor-paginated. */
export async function fetchBlueskyAuthorFeed(
  actor: string,
  options: { maxPosts?: number; actorDid?: string | null } = {},
): Promise<FeedResult> {
  const handle = actor.trim().replace(/^@/, "");
  if (!handle) {
    return { ok: false, reason: "No Bluesky handle for this identity.", rateLimited: false };
  }
  const maxPosts = Math.max(1, Math.min(500, options.maxPosts ?? 100));
  const posts: ProviderPost[] = [];
  let cursor: string | undefined;

  // Bounded loop: a runaway pagination against a large account would be
  // both slow and pointless for a reconciliation report.
  for (let page = 0; page < 6 && posts.length < maxPosts; page += 1) {
    const url =
      `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed` +
      `?actor=${encodeURIComponent(handle)}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, {
        method: "GET",
        headers: { "User-Agent": UA },
        timeoutMs: TIMEOUT_MS,
      });
    } catch (err) {
      return {
        ok: false,
        reason: isTimeoutError(err)
          ? "Bluesky author feed request timed out."
          : "Bluesky author feed request failed.",
        rateLimited: false,
      };
    }
    if (resp.status === 429) {
      return { ok: false, reason: "Bluesky rate-limited the feed read.", rateLimited: true };
    }
    if (!resp.ok) {
      return {
        ok: false,
        reason: `Bluesky getAuthorFeed returned ${resp.status}.`,
        rateLimited: false,
      };
    }

    const payload = (await safeJson(resp)) as { cursor?: unknown } | null;
    posts.push(...parseBlueskyAuthorFeed(payload, options.actorDid ?? null));
    cursor = typeof payload?.cursor === "string" ? payload.cursor : undefined;
    if (!cursor) break;
  }

  return { ok: true, posts: posts.slice(0, maxPosts), truncated: posts.length > maxPosts };
}

/** PURE — maps GET /2/users/{id}/tweets onto ProviderPost. */
export function parseXTimeline(payload: unknown): ProviderPost[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const out: ProviderPost[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as {
      id?: unknown;
      text?: unknown;
      created_at?: unknown;
      public_metrics?: unknown;
      referenced_tweets?: unknown;
    };
    if (typeof t.id !== "string") continue;

    const refs = Array.isArray(t.referenced_tweets)
      ? (t.referenced_tweets as Array<{ type?: unknown }>)
      : [];
    const isRepost = refs.some((r) => r.type === "retweeted");
    const isReply = refs.some((r) => r.type === "replied_to");

    const metrics = parsePublicMetrics(t.public_metrics);
    out.push({
      providerPostId: t.id,
      platform: "x",
      publishedAt:
        typeof t.created_at === "string" ? t.created_at : new Date(0).toISOString(),
      engagement: engagementCount(metrics),
      excerpt: typeof t.text === "string" ? t.text.slice(0, 120) : null,
      isRepost,
      isReply,
    });
  }
  return out;
}

export interface XTimelineContext {
  db: SupabaseClient;
  workspaceId: string;
  accountId: string | null;
  /** X numeric user id. Resolved from the connection when omitted. */
  providerUserId?: string | null;
  nowIso?: string;
}

/**
 * X own-timeline read.
 *
 * COST: this is an Owned Read at $0.001 per resource returned. A single
 * page of 100 posts costs $0.10 at most. The caller decides whether that
 * is warranted; this function does not gate spend itself, because the
 * backfill's cost gate is the one place that decision belongs.
 */
export async function fetchXOwnTimeline(
  ctx: XTimelineContext,
  options: { maxPosts?: number } = {},
): Promise<FeedResult> {
  const { resolveXAccessTokenForMetrics } = await import(
    "@/core/metrics/x-token-access"
  );
  const token = await resolveXAccessTokenForMetrics(ctx);
  if (!token.ok) return { ok: false, reason: token.reason, rateLimited: false };

  const userId = ctx.providerUserId?.trim();
  if (!userId || !/^\d+$/.test(userId)) {
    return {
      ok: false,
      reason:
        "No X numeric user id is stored for this identity, so its own timeline cannot be addressed.",
      rateLimited: false,
    };
  }

  const maxResults = Math.max(5, Math.min(100, options.maxPosts ?? 100));
  const url =
    `${X_API_BASE}/2/users/${encodeURIComponent(userId)}/tweets` +
    `?max_results=${maxResults}` +
    `&tweet.fields=${encodeURIComponent("public_metrics,created_at,referenced_tweets")}`;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "User-Agent": UA,
        Accept: "application/json",
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      reason: isTimeoutError(err)
        ? "X timeline request timed out."
        : "X timeline request failed.",
      rateLimited: false,
    };
  }

  if (!resp.ok) {
    const classified = classifyXReadError(resp.status, await safeJson(resp));
    return {
      ok: false,
      reason: classified.message,
      rateLimited: classified.kind === "rate_limited",
    };
  }

  const posts = parseXTimeline(await safeJson(resp));
  return { ok: true, posts, truncated: posts.length >= maxResults };
}

async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
