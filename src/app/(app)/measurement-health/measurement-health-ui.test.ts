import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  AccountRow,
  AlertRow,
  CoverageRow,
  HEALTH_BADGE,
  HEALTH_LABEL,
  ProviderRow,
} from "./_panels";
import {
  ALL_EMPTY_STATES,
  BANNED_EMPTY_PHRASES,
  emptyState,
  emptyStateForCoverage,
  isBannedEmptyPhrase,
} from "@/core/metrics/health/empty-states";
import type { CoverageSummary } from "@/core/metrics/coverage";

const ALL_STATES = Object.keys(HEALTH_LABEL) as Array<keyof typeof HEALTH_LABEL>;

function coverage(over: Partial<CoverageSummary> = {}): CoverageSummary {
  return {
    platform: "bluesky",
    accountId: "a1",
    publishAttempts: 20,
    publishedPosts: 13,
    measurablePosts: 13,
    postsWithFreshSnapshots: 0,
    postsMissingSnapshots: 13,
    coveragePercent: 0,
    oldestMissingPublishedAt: "2026-06-13T16:15:00Z",
    newestSuccessfulSnapshotAt: null,
    byState: {
      not_yet_due: 0, covered: 0, partially_covered: 0, stale: 0,
      provider_unavailable: 1, provider_error: 0, missing_provider_post_id: 0,
      outside_recoverable_window: 12,
    },
    backfillRecoverable: 12,
    summary: "bluesky: 0 of 13 measurable post(s) have a current measurement (0%).",
    ...over,
  };
}

describe("TRUTHFUL EMPTY STATES", () => {
  it("has a distinct message and label for each situation", () => {
    const labels = ALL_EMPTY_STATES.map((s) => s.label);
    const messages = ALL_EMPTY_STATES.map((s) => s.message);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(messages).size).toBe(messages.length);
    expect(ALL_EMPTY_STATES.length).toBeGreaterThanOrEqual(8);
  });

  it("never uses a generic phrasing", () => {
    for (const state of ALL_EMPTY_STATES) {
      expect(isBannedEmptyPhrase(state.label), state.key).toBe(false);
      expect(isBannedEmptyPhrase(state.message), state.key).toBe(false);
    }
  });

  it("keeps unavailable, error, stale and not-measured genuinely apart", () => {
    const unavailable = emptyState("provider_does_not_expose");
    const error = emptyState("provider_error");
    const stale = emptyState("stale");
    const never = emptyState("never_measured");

    expect(unavailable.message).toContain("property of the platform");
    expect(unavailable.action).toBeNull(); // nothing can clear it
    expect(error.message).toContain("It is not zero");
    expect(stale.message).toContain("not been refreshed");
    expect(never.message).toContain("none has been collected");

    const all = [unavailable, error, stale, never].map((s) => s.message);
    expect(new Set(all).size).toBe(4);
  });

  it("says plainly that insufficient data is a real answer", () => {
    expect(emptyState("insufficient_data").message).toContain("real answer, not a missing one");
  });

  it("maps every coverage state onto the right empty state", () => {
    expect(emptyStateForCoverage("outside_recoverable_window")!.key).toBe("backfill_not_run");
    expect(emptyStateForCoverage("provider_error")!.key).toBe("provider_error");
    expect(emptyStateForCoverage("stale")!.key).toBe("stale");
    expect(emptyStateForCoverage("covered")).toBeNull();
  });
});

describe("rendered panels never emit a generic empty", () => {
  function renderAll(): string {
    return [
      renderToStaticMarkup(
        createElement(CoverageRow, { platform: coverage() }),
      ),
      renderToStaticMarkup(
        createElement(CoverageRow, {
          platform: coverage({ coveragePercent: null, publishedPosts: 0, measurablePosts: 0, backfillRecoverable: 0 }),
        }),
      ),
      renderToStaticMarkup(
        createElement(AccountRow, {
          account: {
            accountId: "a1", platform: "bluesky", handle: "webmasterid.bsky.social",
            followers: null, following: null, postCount: null,
            fetchedAt: null, ageHours: null, freshness: null, error: null,
          },
        }),
      ),
      renderToStaticMarkup(
        createElement(ProviderRow, {
          provider: {
            platform: "x", state: "never_run", lastSuccessfulReadAt: null, lastAttemptAt: null,
            consecutiveFailedRuns: 0, attemptedLastRun: 0, succeededLastRun: 0,
            evidence: "No read has been attempted for x.",
          },
        }),
      ),
    ].join("\n");
  }

  it("contains none of the banned phrasings", () => {
    const html = renderAll().toLowerCase();
    for (const phrase of BANNED_EMPTY_PHRASES) {
      expect(html, `banned phrase rendered: ${phrase}`).not.toContain(`>${phrase}<`);
    }
  });

  it("renders no bare zero where a value is absent", () => {
    const html = renderToStaticMarkup(
      createElement(AccountRow, {
        account: {
          accountId: "a1", platform: "bluesky", handle: null,
          followers: null, following: null, postCount: null,
          fetchedAt: null, ageHours: null, freshness: null, error: null,
        },
      }),
    );
    expect(html).not.toMatch(/>0 followers</);
    expect(html).toContain("Never measured");
  });

  it("says WHY coverage is low rather than showing a bare percentage", () => {
    const html = renderToStaticMarkup(createElement(CoverageRow, { platform: coverage() }));
    expect(html).toContain("0 / 13");
    expect(html).toContain("bounded historical backfill");
    expect(html).toContain("blocked and failed attempts are excluded");
  });
});

describe("health state vocabulary", () => {
  it("has a label and a badge for every state", () => {
    for (const state of ALL_STATES) {
      expect(HEALTH_LABEL[state]).toBeTruthy();
      expect(HEALTH_BADGE[state]).toMatch(/^badge badge-[a-z]+$/);
    }
  });

  it("never_run reads as never run, not as an error", () => {
    expect(HEALTH_LABEL.never_run).toBe("Never run");
    expect(HEALTH_BADGE.never_run).not.toContain("high");
  });

  it("renders a provider row that has never been attempted honestly", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderRow, {
        provider: {
          platform: "devto", state: "never_run", lastSuccessfulReadAt: null, lastAttemptAt: null,
          consecutiveFailedRuns: 0, attemptedLastRun: 0, succeededLastRun: 0,
          evidence: "No read has been attempted for devto.",
        },
      }),
    );
    expect(html).toContain("Never run");
    expect(html).toContain("last successful read: never");
  });
});

describe("alerts render with evidence and action", () => {
  it("shows both", () => {
    const html = renderToStaticMarkup(
      createElement(AlertRow, {
        alert: {
          key: "refresh_never_run", severity: "critical",
          title: "Measurement has never run",
          evidence: "No refresh run has ever been recorded.",
          action: "Confirm the cron is registered.",
        },
      }),
    );
    expect(html).toContain("Measurement has never run");
    expect(html).toContain("No refresh run has ever been recorded.");
    expect(html).toContain("Confirm the cron is registered.");
  });
});

describe("mobile layout", () => {
  it("wraps rather than overflowing at narrow widths", () => {
    const html = renderToStaticMarkup(createElement(CoverageRow, { platform: coverage() }));
    expect(html).toContain("flex-wrap");
  });

  it("lets a long provider handle break — real 320px regression", () => {
    // Caught in browser QA: an unbroken handle pushed the page 30px wide
    // at 320px. flex-wrap alone was not enough; the child needed to be
    // allowed to shrink and break.
    const html = renderToStaticMarkup(
      createElement(AccountRow, {
        account: {
          accountId: "a1", platform: "bluesky",
          handle: "averyveryverylonghandlename.bsky.social",
          followers: 1, following: 10, postCount: 22,
          fetchedAt: "2026-08-20T06:00:00Z", ageHours: 6, freshness: "fresh", error: null,
        },
      }),
    );
    expect(html).toContain("min-w-0");
    expect(html).toContain("break-all");
  });

  it("lets long handles break instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderRow, {
        provider: {
          platform: "bluesky", state: "healthy",
          lastSuccessfulReadAt: "2026-08-20T06:00:00Z", lastAttemptAt: "2026-08-20T06:00:00Z",
          consecutiveFailedRuns: 0, attemptedLastRun: 1, succeededLastRun: 1,
          evidence: "1 of 1 read(s) returned data on the last run.",
        },
      }),
    );
    expect(html).toContain("flex-wrap");
  });
});
