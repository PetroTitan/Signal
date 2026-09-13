/**
 * Follower-import progression — pure decision logic.
 *
 * Given the state of a run and the page the provider just returned,
 * decide what the run's state becomes. No I/O; the caller performs the
 * fetch and the writes.
 *
 * THE INVARIANT THIS FILE PROTECTS
 * --------------------------------
 * A run reaches `completed` on exactly one condition: the provider
 * returned a page with **no cursor**.
 *
 * It is tempting to also complete when `followers.length < limit`, and
 * it is wrong. Walking `bsky.app` with `limit=5` returned pages of 5,
 * then 3, then 4, each with a cursor and more data behind it. `limit` is
 * an upper bound the provider is free to undershoot. Treating a short
 * page as the end would have silently truncated that import at 8 of
 * 34 million followers while reporting success.
 *
 * A run that stops for any other reason — page budget, rate limit,
 * provider error, operator — is `paused` or `failed` with its cursor
 * preserved, which is what makes the import resumable rather than
 * restartable.
 */

import type { BlueskyImportRunStatus } from "@/lib/supabase/types";
import type { FollowerPage, GraphFailure } from "./atproto-graph";

/**
 * How many provider pages one invocation may fetch before yielding.
 *
 * This is a secondary safety ceiling, not the operator-facing amount.
 * Bluesky may return short pages even while a cursor remains, so the
 * primary boundary is `DEFAULT_FOLLOWER_BUDGET` below. 250 pages is
 * enough to reach 10,000 even at the 40-followers/page low end observed
 * in production, while still bounding pathological empty/short-page
 * responses.
 */
export const DEFAULT_PAGE_BUDGET = 250;
/** Followers one click may import before yielding with its cursor saved. */
export const DEFAULT_FOLLOWER_BUDGET = 10_000;
/** Runtime available to the import server action on Vercel Pro. */
export const RELATIONSHIP_IMPORT_MAX_DURATION_SECONDS = 300;
/** Followers per page. The provider's maximum. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Stop the run while this much of the read budget remains, rather than
 * running into the wall. Respecting a published limit early is not
 * evasion — it results in strictly fewer requests, and it keeps the
 * cursor valid instead of losing a page to a refusal.
 */
export const RATE_LIMIT_FLOOR = 50;

export interface ImportRunState {
  status: BlueskyImportRunStatus;
  cursor: string | null;
  cursorExhausted: boolean;
  pagesFetched: number;
  followersSeen: number;
}

export type ImportStopReason =
  | "page_budget"
  | "follower_budget"
  | "rate_limited"
  | "provider_error"
  | "operator";

export interface ImportProgress {
  status: BlueskyImportRunStatus;
  cursor: string | null;
  cursorExhausted: boolean;
  pagesFetched: number;
  followersSeen: number;
  stopReason: ImportStopReason | null;
  lastError: string | null;
  /** Whether the caller should fetch another page in this invocation. */
  continueNow: boolean;
  /**
   * Whether a later invocation can resume. False only when the run is
   * genuinely finished.
   */
  resumable: boolean;
}

/**
 * Fold one successful page into the run state.
 *
 * `pageBudget` bounds a single invocation so a large import cannot
 * monopolise a request; the run pauses with a valid cursor and the
 * operator (or the next invocation) continues it.
 */
export function applyPage(input: {
  state: ImportRunState;
  page: FollowerPage;
  newFollowerCount: number;
  pageBudget?: number;
  /** Absolute run total at which this invocation must yield. */
  followerCeiling?: number;
  /** Rate-limit remaining, when the provider reported one. */
  rateLimitRemaining?: number | null;
}): ImportProgress {
  const budget = input.pageBudget ?? DEFAULT_PAGE_BUDGET;
  const pagesFetched = input.state.pagesFetched + 1;
  const followersSeen = input.state.followersSeen + input.newFollowerCount;

  // === The completion decision. Cursor, and only cursor. ===
  //
  // Note what is deliberately NOT consulted here: page.followers.length,
  // the requested limit, and any follower count from the profile. A
  // short page is not an ending.
  if (input.page.cursor === null) {
    return {
      status: "completed",
      cursor: null,
      cursorExhausted: true,
      pagesFetched,
      followersSeen,
      stopReason: null,
      lastError: null,
      continueNow: false,
      resumable: false,
    };
  }

  // More to fetch. Everything below keeps the cursor.
  const base = {
    cursor: input.page.cursor,
    cursorExhausted: false,
    pagesFetched,
    followersSeen,
    resumable: true,
  };

  const remaining = input.rateLimitRemaining;
  if (typeof remaining === "number" && remaining <= RATE_LIMIT_FLOOR) {
    return {
      ...base,
      status: "paused",
      stopReason: "rate_limited",
      lastError: `Paused with ${remaining} requests left in the provider's window. Progress is saved; continue when the window resets.`,
      continueNow: false,
    };
  }

  if (
    typeof input.followerCeiling === "number" &&
    followersSeen >= input.followerCeiling
  ) {
    return {
      ...base,
      status: "paused",
      stopReason: "follower_budget",
      lastError: null,
      continueNow: false,
    };
  }

  if (pagesFetched >= budget) {
    return {
      ...base,
      status: "paused",
      stopReason: "page_budget",
      lastError: null,
      continueNow: false,
    };
  }

  return {
    ...base,
    status: "running",
    stopReason: null,
    lastError: null,
    continueNow: true,
  };
}

/**
 * Fold a FAILED page fetch into the run state.
 *
 * The cursor is left exactly as it was, so the next attempt re-requests
 * the page that failed rather than skipping it. `cursorExhausted` stays
 * false, so the database CHECK constraint would reject any attempt to
 * call this run complete.
 */
export function applyFailure(input: {
  state: ImportRunState;
  failure: GraphFailure;
}): ImportProgress {
  const rateLimited = input.failure.kind === "rate_limited";
  return {
    // A rate limit is a pause (resume later, nothing is wrong); anything
    // else is a failure the operator should see. Both keep the cursor.
    status: rateLimited ? "paused" : "failed",
    cursor: input.state.cursor,
    cursorExhausted: false,
    pagesFetched: input.state.pagesFetched,
    followersSeen: input.state.followersSeen,
    stopReason: rateLimited ? "rate_limited" : "provider_error",
    lastError: input.failure.message,
    continueNow: false,
    resumable: true,
  };
}

/**
 * How to describe a run's completeness to an operator.
 *
 * This function is the reason the UI cannot accidentally say "imported"
 * about a partial list: the only phrasing that asserts completeness is
 * behind `cursorExhausted`.
 */
export function describeImportProgress(state: {
  status: BlueskyImportRunStatus;
  cursorExhausted: boolean;
  followersSeen: number;
  stopReason?: string | null;
}): string {
  const seen = state.followersSeen.toLocaleString();
  if (state.cursorExhausted && state.status === "completed") {
    return `Complete — all ${seen} followers imported.`;
  }
  switch (state.status) {
    case "pending":
      return "Not started.";
    case "running":
      return `In progress — ${seen} followers so far.`;
    case "paused":
      return state.stopReason === "rate_limited"
        ? `Paused at ${seen} followers (Bluesky rate limit). Progress is saved.`
        : state.stopReason === "follower_budget"
          ? `Paused at ${seen} followers after this 10,000-profile import. Run again to import the next 10,000.`
        : `Paused at ${seen} followers. Continue to import the rest.`;
    case "failed":
      return `Stopped at ${seen} followers. Progress is saved; continue to retry.`;
    case "completed":
      // Unreachable while the database CHECK holds, but stated rather
      // than assumed: if a row ever reaches here, do not claim it is
      // complete.
      return `${seen} followers imported; completeness not confirmed.`;
  }
}
