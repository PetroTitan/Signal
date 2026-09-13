import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applyPage,
  DEFAULT_FOLLOWER_BUDGET,
  DEFAULT_PAGE_BUDGET,
  describeImportProgress,
  RATE_LIMIT_FLOOR,
  type ImportRunState,
} from "./import-plan";
import type { GraphFailure } from "./atproto-graph";

const fresh: ImportRunState = {
  status: "running",
  cursor: null,
  cursorExhausted: false,
  pagesFetched: 0,
  followersSeen: 0,
};

describe("applyPage — completion is cursor exhaustion and nothing else", () => {
  it("completes only when the provider returns no cursor", () => {
    const progress = applyPage({
      state: fresh,
      page: { followers: [], cursor: null },
      newFollowerCount: 0,
    });
    expect(progress.status).toBe("completed");
    expect(progress.cursorExhausted).toBe(true);
    expect(progress.resumable).toBe(false);
  });

  it("does NOT complete on a short page — the verified 5/3/4 walk", () => {
    // Live evidence: getFollowers(limit=5) returned 5, then 3, then 4,
    // each with a cursor and 34 million followers still to come. A page
    // smaller than the limit says nothing about the end of the list.
    const progress = applyPage({
      state: { ...fresh, pagesFetched: 1 },
      page: {
        followers: Array.from({ length: 3 }, (_, i) => ({
          did: `did:plc:${i}`,
          handle: null,
          displayName: null,
          avatarUrl: null,
          followersCount: null,
        })),
        cursor: "5fkcnydoxrt2h",
      },
      newFollowerCount: 3,
      pageBudget: 10,
    });
    expect(progress.status).toBe("running");
    expect(progress.cursorExhausted).toBe(false);
    expect(progress.cursor).toBe("5fkcnydoxrt2h");
    expect(progress.continueNow).toBe(true);
  });

  it("does not complete even on a completely EMPTY page that still has a cursor", () => {
    const progress = applyPage({
      state: fresh,
      page: { followers: [], cursor: "still-more" },
      newFollowerCount: 0,
    });
    expect(progress.status).not.toBe("completed");
    expect(progress.cursorExhausted).toBe(false);
  });

  it("accumulates counters across pages", () => {
    const progress = applyPage({
      state: { ...fresh, pagesFetched: 4, followersSeen: 400 },
      page: { followers: [], cursor: "next" },
      newFollowerCount: 97,
    });
    expect(progress.pagesFetched).toBe(5);
    expect(progress.followersSeen).toBe(497);
  });
});

describe("applyPage — bounded and resumable", () => {
  it("offers 10,000 followers per click with a short-page safety ceiling", () => {
    expect(DEFAULT_FOLLOWER_BUDGET).toBe(10_000);
    expect(DEFAULT_PAGE_BUDGET).toBe(250);
  });

  it("pauses at the follower budget with the cursor kept", () => {
    const progress = applyPage({
      state: { ...fresh, followersSeen: 9_900 },
      page: { followers: [], cursor: "next-10k" },
      newFollowerCount: 100,
      pageBudget: 250,
      followerCeiling: 10_000,
    });
    expect(progress.status).toBe("paused");
    expect(progress.stopReason).toBe("follower_budget");
    expect(progress.followersSeen).toBe(10_000);
    expect(progress.cursor).toBe("next-10k");
    expect(progress.continueNow).toBe(false);
  });

  it("pauses at the page budget with the cursor kept", () => {
    const progress = applyPage({
      state: { ...fresh, pagesFetched: 9 },
      page: { followers: [], cursor: "abc" },
      newFollowerCount: 100,
      pageBudget: 10,
    });
    expect(progress.status).toBe("paused");
    expect(progress.stopReason).toBe("page_budget");
    expect(progress.cursor).toBe("abc");
    expect(progress.resumable).toBe(true);
    expect(progress.continueNow).toBe(false);
  });

  it("pauses before the rate-limit window is exhausted, not after", () => {
    const progress = applyPage({
      state: fresh,
      page: { followers: [], cursor: "abc" },
      newFollowerCount: 100,
      rateLimitRemaining: RATE_LIMIT_FLOOR,
    });
    expect(progress.status).toBe("paused");
    expect(progress.stopReason).toBe("rate_limited");
    expect(progress.cursor).toBe("abc");
  });

  it("keeps going while the window is comfortable", () => {
    const progress = applyPage({
      state: fresh,
      page: { followers: [], cursor: "abc" },
      newFollowerCount: 100,
      rateLimitRemaining: 2999,
    });
    expect(progress.status).toBe("running");
    expect(progress.continueNow).toBe(true);
  });
});

describe("applyFailure — a failed page never advances the cursor", () => {
  const failure = (kind: GraphFailure["kind"]): GraphFailure => ({
    ok: false,
    kind,
    status: kind === "rate_limited" ? 429 : 502,
    errorCode: null,
    message: "provider unavailable",
    rateLimit: null,
  });

  it("re-requests the same page next time rather than skipping it", () => {
    const progress = applyFailure({
      state: { ...fresh, cursor: "page-7", pagesFetched: 6, followersSeen: 600 },
      failure: failure("provider_error"),
    });
    expect(progress.cursor).toBe("page-7");
    expect(progress.pagesFetched).toBe(6);
    expect(progress.followersSeen).toBe(600);
    expect(progress.status).toBe("failed");
    expect(progress.resumable).toBe(true);
  });

  it("never marks the cursor exhausted on a failure", () => {
    for (const kind of ["network", "rate_limited", "auth", "provider_error"] as const) {
      const progress = applyFailure({ state: fresh, failure: failure(kind) });
      expect(progress.cursorExhausted).toBe(false);
      expect(progress.status).not.toBe("completed");
    }
  });

  it("treats a rate limit as a pause, not a failure", () => {
    const progress = applyFailure({ state: fresh, failure: failure("rate_limited") });
    expect(progress.status).toBe("paused");
    expect(progress.stopReason).toBe("rate_limited");
  });
});

describe("describeImportProgress", () => {
  it("claims completeness only when the cursor is exhausted", () => {
    expect(
      describeImportProgress({
        status: "completed",
        cursorExhausted: true,
        followersSeen: 1200,
      }),
    ).toContain("Complete");
  });

  it("never says 'complete' for a paused run", () => {
    const text = describeImportProgress({
      status: "paused",
      cursorExhausted: false,
      followersSeen: 800,
      stopReason: "page_budget",
    });
    expect(text.toLowerCase()).not.toContain("complete");
    expect(text).toContain("800");
  });

  it("refuses to claim completeness for a 'completed' row whose cursor is not exhausted", () => {
    // The database CHECK makes this state unreachable; the copy is
    // defensive rather than trusting.
    const text = describeImportProgress({
      status: "completed",
      cursorExhausted: false,
      followersSeen: 5,
    });
    expect(text).toContain("not confirmed");
  });

  it("names the rate limit when that is why it stopped", () => {
    expect(
      describeImportProgress({
        status: "paused",
        cursorExhausted: false,
        followersSeen: 300,
        stopReason: "rate_limited",
      }),
    ).toContain("rate limit");
  });
});
