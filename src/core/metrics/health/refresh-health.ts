/**
 * Refresh health evaluator (PURE).
 *
 * Answers "is social measurement actually working?" with evidence, and
 * refuses to collapse the answer into red/green. The states below mean
 * genuinely different things and need different operator responses:
 *
 *   never_run             nothing has ever executed — check the cron
 *   configuration_error   the run could not reach its dependencies
 *   database_error        the run reached the database and it refused
 *   provider_error        a provider is returning nothing usable
 *   rate_limited          throttled; waiting is the correct response
 *   stale                 it ran, but too long ago to trust
 *   degraded              partially working — some providers fine
 *   healthy               ran recently and measured something
 *
 * PROVIDER ISOLATION IS THE POINT.
 * X failing must never mark Bluesky unhealthy, and it must never produce
 * "Social Intelligence: broken". Each provider is evaluated from its own
 * counters, and the overall state is derived from theirs rather than
 * replacing them.
 *
 * Pure module — no I/O, no clock (`nowIso` is passed in).
 */

import type { RefreshRunHistory, RefreshRunSummary } from "@/repositories/metrics-refresh-run-repository";

export type RefreshHealthState =
  | "healthy"
  | "degraded"
  | "stale"
  | "never_run"
  | "rate_limited"
  | "provider_error"
  | "configuration_error"
  | "database_error";

/** The sweep is a daily cron, so a day is the expected interval. */
export const EXPECTED_INTERVAL_HOURS = 24;

/**
 * Grace before a missed run counts as stale. A cron can slip; two full
 * expected intervals cannot be explained by slippage.
 */
export const STALE_AFTER_HOURS = EXPECTED_INTERVAL_HOURS * 2;

/** Consecutive failing runs before a provider is called unhealthy rather
 *  than unlucky. One bad night is not an incident. */
export const PROVIDER_FAILURE_STREAK = 2;

export interface ProviderCounters {
  attempted?: number;
  connected?: number;
  unavailable?: number;
  unsupported?: number;
  rateLimited?: number;
  failed?: number;
  skipped?: number;
}

export interface ProviderHealth {
  platform: string;
  state: RefreshHealthState;
  lastSuccessfulReadAt: string | null;
  lastAttemptAt: string | null;
  consecutiveFailedRuns: number;
  attemptedLastRun: number;
  succeededLastRun: number;
  evidence: string;
}

export interface RefreshHealth {
  overall: RefreshHealthState;
  everRan: boolean;
  lastRunAt: string | null;
  lastRunPhase: string | null;
  lastRunTrigger: string | null;
  lastSuccessfulRunAt: string | null;
  hoursSinceLastRun: number | null;
  hoursSinceLastSuccess: number | null;
  expectedIntervalHours: number;
  overdue: boolean;
  /** Why the last run measured nothing, when it measured nothing. */
  lastZeroReason: string | null;
  providers: ProviderHealth[];
  evidence: string[];
  summary: string;
}

export interface EvaluateInput {
  history: RefreshRunHistory;
  nowIso: string;
  /** Platforms the capability model says are readable. */
  verifiedPlatforms: readonly string[];
  expectedIntervalHours?: number;
}

export function evaluateRefreshHealth(input: EvaluateInput): RefreshHealth {
  const { history, nowIso } = input;
  const expectedIntervalHours = input.expectedIntervalHours ?? EXPECTED_INTERVAL_HOURS;

  // The run table itself being unreachable is its own diagnosis, and a
  // much more useful one than "unhealthy".
  if (history.unavailable) {
    return {
      overall: looksLikeMissingSchema(history.unavailableReason)
        ? "configuration_error"
        : "database_error",
      everRan: false,
      lastRunAt: null,
      lastRunPhase: null,
      lastRunTrigger: null,
      lastSuccessfulRunAt: null,
      hoursSinceLastRun: null,
      hoursSinceLastSuccess: null,
      expectedIntervalHours,
      overdue: false,
      lastZeroReason: null,
      providers: [],
      evidence: [
        looksLikeMissingSchema(history.unavailableReason)
          ? "The refresh-run table is not present. The migration that creates it has probably not been applied."
          : `Refresh history could not be read: ${history.unavailableReason ?? "unknown error"}.`,
      ],
      summary: looksLikeMissingSchema(history.unavailableReason)
        ? "Measurement health cannot be assessed: the schema is missing."
        : "Measurement health cannot be assessed: the database refused the read.",
    };
  }

  if (!history.lastRun) {
    return {
      overall: "never_run",
      everRan: false,
      lastRunAt: null,
      lastRunPhase: null,
      lastRunTrigger: null,
      lastSuccessfulRunAt: null,
      hoursSinceLastRun: null,
      hoursSinceLastSuccess: null,
      expectedIntervalHours,
      overdue: true,
      lastZeroReason: null,
      providers: input.verifiedPlatforms.map((platform) => neverRanProvider(platform)),
      evidence: [
        "No refresh run has ever been recorded. Either the scheduled job has not fired, or it has never reached the point of writing a record.",
      ],
      summary: "Measurement has never run.",
    };
  }

  const last = history.lastRun;
  const hoursSinceLastRun = hoursBetween(last.startedAt, nowIso);
  const hoursSinceLastSuccess = history.lastSuccessfulRun
    ? hoursBetween(history.lastSuccessfulRun.startedAt, nowIso)
    : null;
  const overdue =
    hoursSinceLastRun != null && hoursSinceLastRun > expectedIntervalHours * 1.5;

  const providers = input.verifiedPlatforms.map((platform) =>
    evaluateProvider(platform, history.recent, nowIso),
  );

  const evidence: string[] = [];
  evidence.push(
    `Last run ${describeAge(hoursSinceLastRun)} (${last.phase}, ${last.trigger}).`,
  );
  evidence.push(
    history.lastSuccessfulRun
      ? `Last run that measured something: ${describeAge(hoursSinceLastSuccess)}.`
      : "No run has ever measured anything.",
  );
  if (last.zeroReason) {
    evidence.push(`Last run measured nothing: ${last.zeroReason}.`);
  }
  if (overdue) {
    evidence.push(
      `Expected roughly every ${expectedIntervalHours}h; the last run is overdue.`,
    );
  }

  const overall = deriveOverall({
    last,
    providers,
    hoursSinceLastRun,
    hoursSinceLastSuccess,
    staleAfterHours: expectedIntervalHours * 2,
  });

  return {
    overall,
    everRan: true,
    lastRunAt: last.startedAt,
    lastRunPhase: last.phase,
    lastRunTrigger: last.trigger,
    lastSuccessfulRunAt: history.lastSuccessfulRun?.startedAt ?? null,
    hoursSinceLastRun,
    hoursSinceLastSuccess,
    expectedIntervalHours,
    overdue,
    lastZeroReason: last.zeroReason,
    providers,
    evidence,
    summary: summarise(overall, providers, last),
  };
}

/**
 * One provider's health, from its own counters only.
 *
 * A provider that was never ATTEMPTED is not failing — it is simply not
 * being read, which for an empty backlog is correct behaviour and must
 * not be reported as an error.
 */
export function evaluateProvider(
  platform: string,
  recent: readonly RefreshRunSummary[],
  nowIso: string,
): ProviderHealth {
  let lastSuccessfulReadAt: string | null = null;
  let lastAttemptAt: string | null = null;
  let consecutiveFailedRuns = 0;
  let streakBroken = false;
  let attemptedLastRun = 0;
  let succeededLastRun = 0;
  let lastRateLimited = 0;

  for (const [index, run] of recent.entries()) {
    const counters = providerCounters(run, platform);
    if (!counters) continue;
    const attempted = counters.attempted ?? 0;
    const connected = counters.connected ?? 0;

    if (index === 0) {
      attemptedLastRun = attempted;
      succeededLastRun = connected;
      lastRateLimited = counters.rateLimited ?? 0;
    }
    if (attempted > 0 && !lastAttemptAt) lastAttemptAt = run.startedAt;
    if (connected > 0 && !lastSuccessfulReadAt) lastSuccessfulReadAt = run.startedAt;

    if (!streakBroken) {
      if (attempted > 0 && connected === 0) consecutiveFailedRuns += 1;
      else if (attempted > 0) streakBroken = true;
    }
  }

  const state = deriveProviderState({
    attemptedLastRun,
    succeededLastRun,
    consecutiveFailedRuns,
    lastRateLimited,
    lastSuccessfulReadAt,
    nowIso,
  });

  return {
    platform,
    state,
    lastSuccessfulReadAt,
    lastAttemptAt,
    consecutiveFailedRuns,
    attemptedLastRun,
    succeededLastRun,
    evidence: describeProvider(platform, state, {
      attemptedLastRun,
      succeededLastRun,
      consecutiveFailedRuns,
      lastSuccessfulReadAt,
      nowIso,
    }),
  };
}

function deriveProviderState(input: {
  attemptedLastRun: number;
  succeededLastRun: number;
  consecutiveFailedRuns: number;
  lastRateLimited: number;
  lastSuccessfulReadAt: string | null;
  nowIso: string;
}): RefreshHealthState {
  if (input.lastRateLimited > 0 && input.succeededLastRun === 0) {
    return "rate_limited";
  }
  if (input.consecutiveFailedRuns >= PROVIDER_FAILURE_STREAK) {
    return "provider_error";
  }
  if (input.succeededLastRun > 0) return "healthy";

  // Attempted-but-nothing-yet, below the streak threshold: one bad run is
  // not an incident.
  if (input.attemptedLastRun > 0) return "degraded";

  // Never attempted in the recorded window.
  if (!input.lastSuccessfulReadAt) return "never_run";

  const age = hoursBetween(input.lastSuccessfulReadAt, input.nowIso);
  return age != null && age > STALE_AFTER_HOURS ? "stale" : "healthy";
}

function deriveOverall(input: {
  last: RefreshRunSummary;
  providers: readonly ProviderHealth[];
  hoursSinceLastRun: number | null;
  hoursSinceLastSuccess: number | null;
  staleAfterHours: number;
}): RefreshHealthState {
  const { last, providers, hoursSinceLastRun, hoursSinceLastSuccess } = input;

  if (last.phase === "failed") {
    return last.zeroReason === "workspace_query_failed" ? "database_error" : "provider_error";
  }
  if (last.zeroReason === "workspace_query_failed") return "database_error";
  if (last.zeroReason === "credentials_missing") return "configuration_error";

  if (hoursSinceLastRun != null && hoursSinceLastRun > input.staleAfterHours) {
    return "stale";
  }

  const active = providers.filter((p) => p.state !== "never_run");
  if (active.length > 0) {
    const unhealthy = active.filter(
      (p) => p.state === "provider_error" || p.state === "rate_limited",
    );
    // ALL active providers unhealthy → report the shared cause. SOME →
    // degraded, so a healthy provider is never described as broken.
    if (unhealthy.length === active.length) {
      return unhealthy.every((p) => p.state === "rate_limited")
        ? "rate_limited"
        : "provider_error";
    }
    if (unhealthy.length > 0) return "degraded";
  }

  // Nothing measured, but for a benign reason (empty backlog, all fresh).
  if (last.succeeded === 0) {
    if (
      last.zeroReason === "all_already_fresh" ||
      last.zeroReason === "zero_candidates"
    ) {
      return "healthy";
    }
    if (last.zeroReason === "all_outside_window") return "degraded";
    if (hoursSinceLastSuccess == null) return "degraded";
    return "stale";
  }

  return "healthy";
}

function summarise(
  overall: RefreshHealthState,
  providers: readonly ProviderHealth[],
  last: RefreshRunSummary,
): string {
  const perProvider = providers
    .filter((p) => p.state !== "never_run")
    .map((p) => `${p.platform}: ${p.state}`)
    .join(", ");

  switch (overall) {
    case "never_run":
      return "Measurement has never run.";
    case "configuration_error":
      return "Measurement is not configured correctly.";
    case "database_error":
      return "Measurement cannot reach the database.";
    case "stale":
      return `Measurement has not run recently enough to trust${perProvider ? ` (${perProvider})` : ""}.`;
    case "rate_limited":
      return `Every provider is rate limited${perProvider ? ` (${perProvider})` : ""}.`;
    case "provider_error":
      return `Providers are not returning usable data${perProvider ? ` (${perProvider})` : ""}.`;
    case "degraded":
      return `Measurement is partly working${perProvider ? ` (${perProvider})` : ""}.`;
    default:
      return last.succeeded > 0
        ? `Measurement is working${perProvider ? ` (${perProvider})` : ""}.`
        : "Measurement is working; there was nothing due to measure.";
  }
}

function describeProvider(
  platform: string,
  state: RefreshHealthState,
  ctx: {
    attemptedLastRun: number;
    succeededLastRun: number;
    consecutiveFailedRuns: number;
    lastSuccessfulReadAt: string | null;
    nowIso: string;
  },
): string {
  switch (state) {
    case "healthy":
      return ctx.succeededLastRun > 0
        ? `${ctx.succeededLastRun} of ${ctx.attemptedLastRun} read(s) returned data on the last run.`
        : `Last successful read ${describeAge(hoursBetween(ctx.lastSuccessfulReadAt ?? "", ctx.nowIso))}.`;
    case "provider_error":
      return `${ctx.consecutiveFailedRuns} consecutive run(s) attempted reads and got nothing usable.`;
    case "rate_limited":
      return "The provider rate-limited the last run. Retrying later should succeed.";
    case "degraded":
      return `The last run attempted ${ctx.attemptedLastRun} read(s) and none returned data — one run, below the ${PROVIDER_FAILURE_STREAK}-run threshold for calling this a fault.`;
    case "stale":
      return `No successful read for ${describeAge(hoursBetween(ctx.lastSuccessfulReadAt ?? "", ctx.nowIso))}.`;
    default:
      return `No read has been attempted for ${platform} in the recorded history.`;
  }
}

function neverRanProvider(platform: string): ProviderHealth {
  return {
    platform,
    state: "never_run",
    lastSuccessfulReadAt: null,
    lastAttemptAt: null,
    consecutiveFailedRuns: 0,
    attemptedLastRun: 0,
    succeededLastRun: 0,
    evidence: `No read has been attempted for ${platform}.`,
  };
}

export function providerCounters(
  run: RefreshRunSummary,
  platform: string,
): ProviderCounters | null {
  const raw = (run.byProvider ?? {})[platform];
  if (!raw || typeof raw !== "object") return null;
  return raw as ProviderCounters;
}

function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round(((to - from) / 3_600_000) * 10) / 10;
}

function describeAge(hours: number | null): string {
  if (hours == null) return "at an unknown time";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`;
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function looksLikeMissingSchema(reason: string | null): boolean {
  if (!reason) return false;
  return /does not exist|undefined table|relation .* does not exist|schema cache/i.test(
    reason,
  );
}
