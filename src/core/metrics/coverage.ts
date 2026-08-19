/**
 * Measurement coverage (PURE).
 *
 * "Does a post_metrics row exist" is not coverage. A row can be stale, can
 * record a provider error, or can hold a partial counter set — none of
 * which is healthy measurement, and all of which would inflate a naive
 * percentage into a reassuring lie.
 *
 * THE DENOMINATOR RULE
 * --------------------
 * Only `outcome = 'published'` counts. A blocked or failed publish
 * attempt never reached a platform, so there is nothing to measure and
 * including it would make coverage fall every time a safety gate
 * correctly refused something. Signal's history has 92 attempts and 44
 * measurable publications; using the wrong denominator would report 48%
 * coverage for a perfectly measured account.
 *
 * Pure module — no I/O, no clock (`nowIso` is passed in).
 */

import { AGE_WINDOWS, classifyAgeWindow, ageHours, type AgeWindow } from "./age-windows";
import { availableMetrics } from "./metric-availability";
import { FRESH_MAX_AGE_HOURS } from "./freshness";

export type CoverageState =
  | "not_yet_due"
  | "covered"
  | "partially_covered"
  | "stale"
  | "provider_unavailable"
  | "provider_error"
  | "missing_provider_post_id"
  | "outside_recoverable_window";

/** Below this age a post has not yet reached its first window, so an
 *  absent measurement is correct rather than missing. */
export const FIRST_WINDOW_HOURS = 1;

export interface PublicationForCoverage {
  publishHistoryId: string;
  platform: string;
  accountId: string | null;
  /** publish_history.outcome — only 'published' is measurable. */
  outcome: string;
  publishedAt: string;
  providerPostId: string | null;
  permalink: string | null;
  /** Latest canonical metrics row, when one exists. */
  metrics: {
    status: string;
    fetchedAt: string | null;
    freshness: string | null;
    ageWindow: string | null;
    counters: Record<string, unknown>;
  } | null;
}

export interface CoverageVerdict {
  publishHistoryId: string;
  platform: string;
  state: CoverageState;
  reason: string;
  /** True when this publication counts toward the coverage denominator. */
  measurable: boolean;
  /** True when it counts as successfully covered. */
  healthy: boolean;
}

export interface CoverageOptions {
  nowIso: string;
  /** The sweep's enrolment window. Publications older than this can only
   *  be reached by the bounded backfill. */
  seedWindowDays: number;
}

export function classifyCoverage(
  publication: PublicationForCoverage,
  options: CoverageOptions,
): CoverageVerdict {
  const base = {
    publishHistoryId: publication.publishHistoryId,
    platform: publication.platform,
  };

  // Never reached a platform: not a coverage gap, not in the denominator.
  if (publication.outcome !== "published") {
    return {
      ...base,
      state: "not_yet_due",
      reason: `Publication outcome was "${publication.outcome}", so nothing reached the platform to measure.`,
      measurable: false,
      healthy: false,
    };
  }

  if (!publication.providerPostId && !publication.permalink) {
    return {
      ...base,
      state: "missing_provider_post_id",
      reason:
        "No provider post id or permalink was recorded, so this publication can never be looked up.",
      measurable: false,
      healthy: false,
    };
  }

  const age = ageHours(publication.publishedAt, options.nowIso);
  const metrics = publication.metrics;

  if (!metrics) {
    if (age != null && age < FIRST_WINDOW_HOURS) {
      return {
        ...base,
        state: "not_yet_due",
        reason: `Published ${formatHours(age)} ago; the first measurement window opens at ${FIRST_WINDOW_HOURS}h.`,
        measurable: true,
        healthy: false,
      };
    }
    const windowHours = options.seedWindowDays * 24;
    if (age != null && age > windowHours) {
      return {
        ...base,
        state: "outside_recoverable_window",
        reason: `Published ${formatHours(age)} ago, beyond the ${options.seedWindowDays}-day enrolment window. The scheduled sweep will never reach it — the bounded backfill can.`,
        measurable: true,
        healthy: false,
      };
    }
    return {
      ...base,
      state: "provider_unavailable",
      reason: `In the enrolment window and ${formatHours(age ?? 0)} old, but no measurement has been recorded.`,
      measurable: true,
      healthy: false,
    };
  }

  if (metrics.status === "unsupported") {
    return {
      ...base,
      state: "provider_unavailable",
      reason: "Signal does not read metrics for this platform.",
      measurable: false,
      healthy: false,
    };
  }

  if (metrics.freshness === "rate_limited") {
    return {
      ...base,
      state: "provider_error",
      reason: "The last read was rate limited, so this measurement is not being updated.",
      measurable: true,
      healthy: false,
    };
  }
  if (metrics.freshness === "provider_error") {
    return {
      ...base,
      state: "provider_error",
      reason: "The last read failed against the provider.",
      measurable: true,
      healthy: false,
    };
  }

  if (metrics.status !== "connected") {
    return {
      ...base,
      state: "provider_unavailable",
      reason: `The provider returned no counts (status "${metrics.status}").`,
      measurable: true,
      healthy: false,
    };
  }

  // Connected — now the quality questions.
  const readingAge = ageHours(metrics.fetchedAt, options.nowIso);
  if (metrics.freshness === "stale" || (readingAge != null && readingAge > FRESH_MAX_AGE_HOURS)) {
    return {
      ...base,
      state: "stale",
      reason: `Measured, but the reading is ${formatHours(readingAge ?? 0)} old and has not been refreshed.`,
      measurable: true,
      healthy: false,
    };
  }

  const expected = availableMetrics(publication.platform);
  const present = expected.filter(
    (key) => typeof metrics.counters[key] === "number",
  );
  if (expected.length > 0 && present.length < expected.length) {
    return {
      ...base,
      state: "partially_covered",
      reason: `Measured, but only ${present.length} of the ${expected.length} counters this platform reports came back.`,
      measurable: true,
      healthy: false,
    };
  }

  return {
    ...base,
    state: "covered",
    reason: `Measured ${formatHours(readingAge ?? 0)} ago with a complete counter set.`,
    measurable: true,
    healthy: true,
  };
}

export interface CoverageSummary {
  platform: string;
  accountId: string | null;
  /** Every publish_history row for this platform, all outcomes. */
  publishAttempts: number;
  /** outcome = 'published' only. The denominator. */
  publishedPosts: number;
  /** Published AND addressable — the honest measurable set. */
  measurablePosts: number;
  postsWithFreshSnapshots: number;
  postsMissingSnapshots: number;
  /** healthy / measurable, or null when nothing is measurable. */
  coveragePercent: number | null;
  oldestMissingPublishedAt: string | null;
  newestSuccessfulSnapshotAt: string | null;
  byState: Record<CoverageState, number>;
  /** Publications only the backfill can reach. */
  backfillRecoverable: number;
  summary: string;
}

export function summarizeCoverage(
  publications: readonly PublicationForCoverage[],
  options: CoverageOptions,
): CoverageSummary[] {
  const platforms = Array.from(new Set(publications.map((p) => p.platform))).sort();

  return platforms.map((platform) => {
    const forPlatform = publications.filter((p) => p.platform === platform);
    const verdicts = forPlatform.map((p) => classifyCoverage(p, options));

    const byState = emptyStateTally();
    for (const v of verdicts) byState[v.state] += 1;

    const published = forPlatform.filter((p) => p.outcome === "published");
    const measurable = verdicts.filter((v) => v.measurable);
    const healthy = verdicts.filter((v) => v.healthy);

    const missing = forPlatform.filter((p, i) => verdicts[i].measurable && !verdicts[i].healthy);
    const oldestMissing = [...missing]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))[0] ?? null;

    const newestSnapshot = [...forPlatform]
      .filter((p) => p.metrics?.status === "connected" && p.metrics.fetchedAt)
      .sort((a, b) => (b.metrics!.fetchedAt ?? "").localeCompare(a.metrics!.fetchedAt ?? ""))[0] ?? null;

    const coveragePercent =
      measurable.length > 0
        ? Math.round((healthy.length / measurable.length) * 1000) / 10
        : null;

    return {
      platform,
      accountId: forPlatform[0]?.accountId ?? null,
      publishAttempts: forPlatform.length,
      publishedPosts: published.length,
      measurablePosts: measurable.length,
      postsWithFreshSnapshots: healthy.length,
      postsMissingSnapshots: measurable.length - healthy.length,
      coveragePercent,
      oldestMissingPublishedAt: oldestMissing?.publishedAt ?? null,
      newestSuccessfulSnapshotAt: newestSnapshot?.metrics?.fetchedAt ?? null,
      byState,
      backfillRecoverable: byState.outside_recoverable_window,
      summary: describeCoverage({
        platform,
        publishAttempts: forPlatform.length,
        publishedPosts: published.length,
        measurablePosts: measurable.length,
        healthy: healthy.length,
        coveragePercent,
        backfillRecoverable: byState.outside_recoverable_window,
      }),
    };
  });
}

function describeCoverage(input: {
  platform: string;
  publishAttempts: number;
  publishedPosts: number;
  measurablePosts: number;
  healthy: number;
  coveragePercent: number | null;
  backfillRecoverable: number;
}): string {
  if (input.publishedPosts === 0) {
    // "Nothing published" and "everything we tried was blocked" are
    // different operational situations.
    return input.publishAttempts > 0
      ? `${input.platform}: ${input.publishAttempts} publish attempt(s), none published, so none measurable.`
      : `${input.platform}: nothing published.`;
  }
  if (input.measurablePosts === 0) {
    return `${input.platform}: ${input.publishedPosts} published, none measurable.`;
  }
  const head =
    `${input.platform}: ${input.healthy} of ${input.measurablePosts} measurable post(s) ` +
    `have a current measurement (${input.coveragePercent}%).`;
  return input.backfillRecoverable > 0
    ? `${head} ${input.backfillRecoverable} are older than the enrolment window and need the backfill.`
    : head;
}

function emptyStateTally(): Record<CoverageState, number> {
  return {
    not_yet_due: 0,
    covered: 0,
    partially_covered: 0,
    stale: 0,
    provider_unavailable: 0,
    provider_error: 0,
    missing_provider_post_id: 0,
    outside_recoverable_window: 0,
  };
}

/** Which age windows a post has a recorded reading for. */
export function windowsCovered(
  readings: ReadonlyArray<{ ageWindow: string | null }>,
): AgeWindow[] {
  const present = new Set(readings.map((r) => r.ageWindow).filter(Boolean));
  return AGE_WINDOWS.filter((w) => present.has(w));
}

/** Windows a post SHOULD have by now, given its age. */
export function windowsDue(publishedAt: string, nowIso: string): AgeWindow[] {
  const age = ageHours(publishedAt, nowIso);
  if (age == null) return [];
  const reached = classifyAgeWindow(age);
  if (reached == null) return [];
  const index = AGE_WINDOWS.indexOf(reached);
  return AGE_WINDOWS.slice(0, index + 1).filter((w) => w !== "older");
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
