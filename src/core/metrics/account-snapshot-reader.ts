import "server-only";
/**
 * Read account-level context from providers.
 *
 * Bluesky: `app.bsky.actor.getProfile` on the PUBLIC AppView. No auth,
 * no key, no cost — the docs state the public endpoints "do not support
 * authentication" at all, so this deliberately sends no credentials.
 *
 * X: `GET /2/users/me` with `user.fields=public_metrics`, which needs the
 * identity's user-context token (app-only is explicitly not supported
 * for /me). Reuses the same token path as the X metrics reader.
 *
 * Read-only. Neither path can mutate anything on either provider.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";
import type { AccountSnapshot } from "./account-context";
import { classifyXReadError, readXRateLimit } from "./x-metrics";

const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app";
const X_API_BASE = "https://api.twitter.com";
const UA = "SignalPublishing/1.0 (metrics; +https://signal.app)";
const TIMEOUT_MS = 15_000;

export type AccountSnapshotResult =
  | { ok: true; snapshot: AccountSnapshot }
  | { ok: false; reason: string; rateLimited: boolean };

/**
 * Parse a Bluesky profile. PURE — exported so the field mapping is
 * testable without a network call.
 *
 * NOTE what is absent: there is no impressions, views or reach field to
 * map, because the profile object has none. Do not add one.
 */
export function parseBlueskyProfile(
  payload: unknown,
  fetchedAt: string,
): AccountSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    did?: unknown;
    handle?: unknown;
    followersCount?: unknown;
    followsCount?: unknown;
    postsCount?: unknown;
    createdAt?: unknown;
  };
  if (typeof p.handle !== "string") return null;
  return {
    platform: "bluesky",
    handle: p.handle,
    providerAccountId: typeof p.did === "string" ? p.did : null,
    followers: numOrNull(p.followersCount),
    following: numOrNull(p.followsCount),
    postCount: numOrNull(p.postsCount),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
    fetchedAt,
    source: "bluesky_getprofile",
  };
}

/**
 * Parse GET /2/users/me. PURE.
 *
 * The docs are inconsistent about the post-count field name — the data
 * dictionary says `tweet_count` while the /2/users/me OpenAPI schema
 * says `post_count` — so both are read and whichever the provider
 * actually sent is used. Guessing one would silently drop the value.
 */
export function parseXUser(
  payload: unknown,
  fetchedAt: string,
): AccountSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const u = data as {
    id?: unknown;
    username?: unknown;
    created_at?: unknown;
    public_metrics?: unknown;
  };
  if (typeof u.username !== "string") return null;
  const pm = (u.public_metrics ?? {}) as Record<string, unknown>;
  return {
    platform: "x",
    handle: u.username,
    providerAccountId: typeof u.id === "string" ? u.id : null,
    followers: numOrNull(pm.followers_count),
    following: numOrNull(pm.following_count),
    postCount: numOrNull(pm.post_count ?? pm.tweet_count),
    createdAt: typeof u.created_at === "string" ? u.created_at : null,
    fetchedAt,
    source: "x_users_me",
  };
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Bluesky profile via the unauthenticated public AppView. */
export async function fetchBlueskyAccountSnapshot(
  actor: string,
  nowIso = new Date().toISOString(),
): Promise<AccountSnapshotResult> {
  const handle = actor.trim().replace(/^@/, "");
  if (!handle) {
    return { ok: false, reason: "No Bluesky handle recorded for this identity.", rateLimited: false };
  }
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
      { method: "GET", headers: { "User-Agent": UA }, timeoutMs: TIMEOUT_MS },
    );
  } catch (err) {
    return {
      ok: false,
      reason: isTimeoutError(err)
        ? "Bluesky profile request timed out."
        : "Bluesky profile request failed.",
      rateLimited: false,
    };
  }
  if (resp.status === 429) {
    return { ok: false, reason: "Bluesky rate-limited the profile read.", rateLimited: true };
  }
  if (!resp.ok) {
    return { ok: false, reason: `Bluesky getProfile returned ${resp.status}.`, rateLimited: false };
  }
  const snapshot = parseBlueskyProfile(await safeJson(resp), nowIso);
  return snapshot
    ? { ok: true, snapshot }
    : { ok: false, reason: "Bluesky returned an unrecognised profile shape.", rateLimited: false };
}

export interface XAccountContext {
  db: SupabaseClient;
  workspaceId: string;
  accountId: string | null;
  nowIso?: string;
}

/** X profile via GET /2/users/me (user-context token required). */
export async function fetchXAccountSnapshot(
  ctx: XAccountContext,
): Promise<AccountSnapshotResult> {
  const nowIso = ctx.nowIso ?? new Date().toISOString();
  const { resolveXAccessTokenForMetrics } = await import("./x-token-access");
  const token = await resolveXAccessTokenForMetrics(ctx);
  if (!token.ok) return { ok: false, reason: token.reason, rateLimited: false };

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${X_API_BASE}/2/users/me?user.fields=public_metrics,created_at,username`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "User-Agent": UA,
          Accept: "application/json",
        },
        timeoutMs: TIMEOUT_MS,
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: isTimeoutError(err) ? "X profile request timed out." : "X profile request failed.",
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

  // Recorded for the sweep's benefit even on success — knowing a run
  // finished with 3 of 75 calls remaining is actionable.
  readXRateLimit(resp.headers);

  const snapshot = parseXUser(await safeJson(resp), nowIso);
  return snapshot
    ? { ok: true, snapshot }
    : { ok: false, reason: "X returned an unrecognised /2/users/me shape.", rateLimited: false };
}

async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
