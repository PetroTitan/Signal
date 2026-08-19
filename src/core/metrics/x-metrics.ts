/**
 * X API v2 metrics — parsing and error classification (PURE).
 *
 * Signal previously declared X metrics unreadable, citing an "elevated/
 * paid API tier this account doesn't have". That was true of the old
 * Free/Basic/Pro model and is no longer true: X moved to pay-per-usage
 * credits in Feb 2026, and `impression_count` sits in `public_metrics`
 * behind nothing more than a bearer token. The scopes Signal already
 * holds — `tweet.read`, `users.read`, `offline.access` — are exactly the
 * documented minimum. See docs/platforms/provider-metric-capabilities.md.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 *   - It does not touch `non_public_metrics` / `organic_metrics`. Those
 *     are user-context, owned-posts-only, and hard-limited to 30 days
 *     from post creation. Signal's oldest measurable posts are months
 *     old, so for most of the corpus that data is already unrecoverable.
 *     Requesting them would add cost and 400s for no gain.
 *   - It does not design against GET /2/tweets/analytics. The endpoint
 *     page is silent on tier, but /x-api/overview lists Analytics under
 *     Enterprise. Treated as unavailable.
 *
 * NULLABLE SEMANTICS ARE LOad-BEARING: a counter the payload did not
 * return stays `undefined`. It must never become 0 — "we did not get a
 * number" and "the number is zero" are different facts, and conflating
 * them is the exact failure this whole milestone exists to avoid.
 *
 * Pure module — no I/O, no clock.
 */

import { coerceCount, type VerifiedMetrics } from "./metrics-provider";

/** The fields we ask X for. `public_metrics` is all-or-nothing: the docs
 *  state you cannot request a single sub-field, and the whole object is
 *  billed as one Post resource either way. */
export const X_TWEET_FIELDS = "public_metrics,created_at";

/** GET /2/tweets accepts up to 100 ids per request. */
export const X_LOOKUP_BATCH_SIZE = 100;

export type XReadErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "usage_capped"
  | "payment_required"
  | "not_found"
  | "server_error"
  | "malformed_payload"
  | "unknown";

export interface XReadError {
  kind: XReadErrorKind;
  /** Operator-facing, no credentials, no raw provider body. */
  message: string;
  /** True when retrying later could plausibly succeed. */
  retryable: boolean;
  /** True when the fix is a human action (reconnect, add credit). */
  needsOperator: boolean;
}

/**
 * Classify an X error response. Status alone is not enough: a 429 can be
 * ordinary throttling OR a billing usage cap, and those need opposite
 * operator responses (wait vs. add credit). X signals the difference in
 * the error body's title/detail, so both are inspected.
 */
export function classifyXReadError(status: number, body: unknown): XReadError {
  const text = errorText(body).toLowerCase();

  if (status === 401) {
    return {
      kind: "unauthorized",
      message:
        "X returned 401 — the access token is invalid, expired or revoked. " +
        "Reconnect the identity from its identity card.",
      retryable: false,
      needsOperator: true,
    };
  }

  if (status === 402 || text.includes("payment required")) {
    return {
      kind: "payment_required",
      message:
        "X returned 402 — the developer project has no available credit. " +
        "Top up at console.x.com; no metrics can be read until then.",
      retryable: false,
      needsOperator: true,
    };
  }

  if (status === 403) {
    // "client-not-enrolled" is X's marker for a project that is not on a
    // plan permitting the endpoint — a billing/enrolment problem wearing
    // a permissions status code.
    if (text.includes("not-enrolled") || text.includes("not enrolled")) {
      return {
        kind: "payment_required",
        message:
          "X returned 403 client-not-enrolled — the developer project is not " +
          "enrolled in a plan that permits reading posts. Enable pay-per-use " +
          "at console.x.com.",
        retryable: false,
        needsOperator: true,
      };
    }
    return {
      kind: "forbidden",
      message:
        "X returned 403 — the token lacks the required scope (tweet.read + " +
        "users.read) or the post is not visible to this account.",
      retryable: false,
      needsOperator: true,
    };
  }

  if (status === 429) {
    if (text.includes("usage cap") || text.includes("usagecap")) {
      return {
        kind: "usage_capped",
        message:
          "X returned 429 UsageCapExceeded — the project's monthly post-read " +
          "cap is exhausted. This is a billing limit, not throttling; it will " +
          "not clear until the cycle resets or the plan changes.",
        retryable: false,
        needsOperator: true,
      };
    }
    return {
      kind: "rate_limited",
      message: "X returned 429 — rate limited. Retrying later should succeed.",
      retryable: true,
      needsOperator: false,
    };
  }

  if (status === 404) {
    return {
      kind: "not_found",
      message: "X returned 404 — the endpoint or post does not exist.",
      retryable: false,
      needsOperator: false,
    };
  }

  if (status >= 500) {
    return {
      kind: "server_error",
      message: `X returned ${status} — provider-side error. Retryable.`,
      retryable: true,
      needsOperator: false,
    };
  }

  return {
    kind: "unknown",
    message: `X returned ${status}.`,
    retryable: status >= 500,
    needsOperator: false,
  };
}

/** Best-effort text from an X error envelope, without echoing the body. */
function errorText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const b = body as {
    title?: unknown;
    detail?: unknown;
    reason?: unknown;
    errors?: Array<{ title?: unknown; detail?: unknown; message?: unknown }>;
  };
  const parts: string[] = [];
  for (const key of ["title", "detail", "reason"] as const) {
    if (typeof b[key] === "string") parts.push(b[key] as string);
  }
  if (Array.isArray(b.errors)) {
    for (const e of b.errors) {
      for (const key of ["title", "detail", "message"] as const) {
        if (typeof e?.[key] === "string") parts.push(e[key] as string);
      }
    }
  }
  return parts.join(" ");
}

export interface XTweetMetrics {
  tweetId: string;
  metrics: VerifiedMetrics;
  /** X `created_at` — the provider's own timestamp for the post. */
  createdAt: string | null;
}

export interface XLookupParse {
  /** Successfully parsed tweets, keyed by id. */
  found: Map<string, XTweetMetrics>;
  /** Ids X explicitly reported as missing/unavailable (deleted, private). */
  missing: Set<string>;
  /** True when the envelope did not look like an X v2 response at all. */
  malformed: boolean;
}

/**
 * Parse a GET /2/tweets response.
 *
 * X reports per-id problems in a top-level `errors` array while still
 * returning 200, so "not found" is a body condition, not a status code.
 * A tweet present in `data` but carrying no `public_metrics` yields an
 * entry with an EMPTY metrics object rather than zeros — we saw the post
 * but got no counters, which is `unavailable`, not "no engagement".
 */
export function parseXLookupResponse(payload: unknown): XLookupParse {
  const found = new Map<string, XTweetMetrics>();
  const missing = new Set<string>();

  if (!payload || typeof payload !== "object") {
    return { found, missing, malformed: true };
  }

  const body = payload as {
    data?: unknown;
    errors?: unknown;
  };

  const hasData = Array.isArray(body.data);
  const hasErrors = Array.isArray(body.errors);
  if (!hasData && !hasErrors) {
    return { found, missing, malformed: true };
  }

  if (hasErrors) {
    for (const raw of body.errors as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { value?: unknown; resource_id?: unknown };
      const id =
        typeof e.value === "string"
          ? e.value
          : typeof e.resource_id === "string"
            ? e.resource_id
            : null;
      if (id) missing.add(id);
    }
  }

  if (hasData) {
    for (const raw of body.data as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as {
        id?: unknown;
        created_at?: unknown;
        public_metrics?: unknown;
      };
      if (typeof t.id !== "string") continue;
      found.set(t.id, {
        tweetId: t.id,
        metrics: parsePublicMetrics(t.public_metrics),
        createdAt: typeof t.created_at === "string" ? t.created_at : null,
      });
    }
  }

  return { found, missing, malformed: false };
}

/**
 * Map X's `public_metrics` onto Signal's normalized shape.
 *
 * Every field is independently optional. `coerceCount` drops anything
 * that is not a finite non-negative number, so a malformed or absent
 * counter disappears rather than becoming 0.
 */
export function parsePublicMetrics(raw: unknown): VerifiedMetrics {
  if (!raw || typeof raw !== "object") return {};
  const m = raw as Record<string, unknown>;
  const out: VerifiedMetrics = {};
  assign(out, "likes", coerceCount(m.like_count));
  assign(out, "replies", coerceCount(m.reply_count));
  assign(out, "reposts", coerceCount(m.retweet_count));
  assign(out, "quotes", coerceCount(m.quote_count));
  assign(out, "bookmarks", coerceCount(m.bookmark_count));
  assign(out, "impressions", coerceCount(m.impression_count));
  return out;
}

function assign<K extends keyof VerifiedMetrics>(
  target: VerifiedMetrics,
  key: K,
  value: number | undefined,
): void {
  // Explicit: only set the key when the provider actually gave us one.
  if (value !== undefined) target[key] = value;
}

/**
 * X's rate-limit headers, normalized. Present on both successful and
 * 429 responses; the sweep records them so an operator can see how close
 * a run came to the ceiling before it started failing.
 */
export interface XRateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export function readXRateLimit(headers: Headers): XRateLimitSnapshot {
  const limit = intOrNull(headers.get("x-rate-limit-limit"));
  const remaining = intOrNull(headers.get("x-rate-limit-remaining"));
  const resetRaw = intOrNull(headers.get("x-rate-limit-reset"));
  return {
    limit,
    remaining,
    resetAt: resetRaw != null ? new Date(resetRaw * 1000).toISOString() : null,
  };
}

function intOrNull(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Split ids into request-sized batches, preserving order. */
export function batchTweetIds(
  ids: string[],
  size = X_LOOKUP_BATCH_SIZE,
): string[][] {
  const clean = ids.map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
  const batches: string[][] = [];
  for (let i = 0; i < clean.length; i += Math.max(1, size)) {
    batches.push(clean.slice(i, i + Math.max(1, size)));
  }
  return batches;
}

/** X post ids are numeric snowflakes; anything else is not addressable. */
export function isXPostId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}
