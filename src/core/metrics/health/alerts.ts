/**
 * Alertable measurement conditions (PURE).
 *
 * Deliberately quiet. A monitoring surface that fires on every transient
 * provider hiccup trains an operator to ignore it, at which point it is
 * worse than nothing — so conditions here need PERSISTENCE (a streak, or
 * a duration) before they speak, and each one names the action that
 * clears it.
 *
 * Reuses Signal's existing activity/notification vocabulary rather than
 * introducing a channel. No external integration.
 *
 * Pure module — no I/O, no clock (`nowIso` is passed in).
 */

import type { RefreshHealth } from "./refresh-health";
import type { CoverageSummary } from "../coverage";
import type { BudgetState } from "../budget/x-read-budget";

export type AlertKey =
  | "refresh_never_run"
  | "refresh_overdue"
  | "schema_missing"
  | "database_unreachable"
  | "provider_failing"
  | "provider_rate_limited"
  | "x_billing_refused"
  | "coverage_below_threshold"
  | "account_snapshots_stale"
  | "backfill_recoverable_work"
  | "budget_exhausted";

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  key: AlertKey;
  severity: AlertSeverity;
  title: string;
  /** What was observed, with numbers. */
  evidence: string;
  /** The action that would clear it. */
  action: string;
}

/** Coverage below this, with enough measurable posts to mean something. */
export const COVERAGE_ALERT_THRESHOLD = 60;
/** Below this many measurable posts, a coverage percentage is noise. */
export const COVERAGE_MIN_SAMPLE = 3;
/** Account context older than this is stale. Snapshots are daily. */
export const ACCOUNT_SNAPSHOT_STALE_HOURS = 48;

export interface AlertInput {
  health: RefreshHealth;
  coverage: readonly CoverageSummary[];
  budget: BudgetState | null;
  /** Hours since the newest account snapshot, or null if none exists. */
  accountSnapshotAgeHours: number | null;
  /** True when at least one identity could be snapshotted. */
  hasSnapshottableAccounts: boolean;
  nowIso: string;
}

export function evaluateAlerts(input: AlertInput): Alert[] {
  const alerts: Alert[] = [];
  const { health } = input;

  // ---- run-level ------------------------------------------------------
  if (health.overall === "configuration_error") {
    alerts.push({
      key: "schema_missing",
      severity: "critical",
      title: "Measurement schema is missing",
      evidence: health.evidence.join(" "),
      action:
        "Apply the outstanding migration, then re-check. See docs/operations/social-intelligence-production-activation.md.",
    });
  }

  if (health.overall === "database_error") {
    alerts.push({
      key: "database_unreachable",
      severity: "critical",
      title: "Measurement cannot reach the database",
      evidence: health.evidence.join(" "),
      action: "Check the service-role configuration for the production environment.",
    });
  }

  if (!health.everRan && health.overall === "never_run") {
    alerts.push({
      key: "refresh_never_run",
      severity: "critical",
      title: "Measurement has never run",
      evidence:
        "No refresh run has ever been recorded, so nothing has been measured and nothing can be trusted as current.",
      action:
        "Confirm the /api/metrics/refresh cron is registered and firing, then trigger one run by hand to confirm the path end to end.",
    });
  } else if (health.overdue) {
    alerts.push({
      key: "refresh_overdue",
      severity: health.overall === "stale" ? "critical" : "warning",
      title: "Measurement is overdue",
      evidence: `Expected roughly every ${health.expectedIntervalHours}h; last run ${describeHours(health.hoursSinceLastRun)} ago.`,
      action: "Check the cron invocation history for the refresh route.",
    });
  }

  // ---- provider-level, one alert per provider so nothing is smeared ----
  for (const provider of health.providers) {
    if (provider.state === "provider_error") {
      // Streak-gated inside the evaluator: one bad run never reaches here.
      alerts.push({
        key: "provider_failing",
        severity: "warning",
        title: `${provider.platform} reads are failing`,
        evidence: `${provider.consecutiveFailedRuns} consecutive run(s) attempted reads and got nothing usable. Last success ${describeIso(provider.lastSuccessfulReadAt)}.`,
        action:
          provider.platform === "x"
            ? "Check the X connection health and that the developer project has credit."
            : `Check ${provider.platform} availability; the read path needs no credentials.`,
      });
    }
    if (provider.state === "rate_limited") {
      alerts.push({
        key: "provider_rate_limited",
        severity: "info",
        title: `${provider.platform} is rate limiting reads`,
        evidence: provider.evidence,
        action: "No action needed — the next run should recover. Persistent throttling means lowering the read volume.",
      });
    }
  }

  // A billing refusal is not a provider outage and does not clear itself.
  const xBilling = health.providers.find(
    (p) => p.platform === "x" && /credit|billing|enrolled|payment/i.test(p.evidence),
  );
  if (xBilling) {
    alerts.push({
      key: "x_billing_refused",
      severity: "critical",
      title: "X refused a read for billing reasons",
      evidence: xBilling.evidence,
      action:
        "Top up or enable pay-per-use at console.x.com. Waiting will not clear this.",
    });
  }

  if (input.budget?.exhausted) {
    alerts.push({
      key: "budget_exhausted",
      severity: "info",
      title: "Daily X read budget is spent",
      evidence: `${input.budget.spentToday} of ${input.budget.limit} resource(s) used today.`,
      action: "It resets at the next UTC day. Raise SIGNAL_DAILY_X_READ_BUDGET if this is routine.",
    });
  }

  // ---- coverage -------------------------------------------------------
  for (const platform of input.coverage) {
    if (
      platform.measurablePosts >= COVERAGE_MIN_SAMPLE &&
      platform.coveragePercent != null &&
      platform.coveragePercent < COVERAGE_ALERT_THRESHOLD
    ) {
      alerts.push({
        key: "coverage_below_threshold",
        severity: "warning",
        title: `${platform.platform} measurement coverage is low`,
        evidence: `${platform.postsWithFreshSnapshots} of ${platform.measurablePosts} measurable post(s) have a current measurement (${platform.coveragePercent}%).`,
        action:
          platform.backfillRecoverable > 0
            ? `${platform.backfillRecoverable} are older than the enrolment window — run the bounded backfill.`
            : "Check that the refresh sweep is reaching this platform.",
      });
    }

    if (platform.backfillRecoverable > 0) {
      alerts.push({
        key: "backfill_recoverable_work",
        severity: "info",
        title: `${platform.platform} has publications only the backfill can reach`,
        evidence: `${platform.backfillRecoverable} publication(s) predate the enrolment window. The scheduled sweep will never enrol them.`,
        action: "Run a bounded backfill for the affected date range. Preview first.",
      });
    }
  }

  // ---- account context ------------------------------------------------
  if (input.hasSnapshottableAccounts) {
    if (input.accountSnapshotAgeHours == null) {
      alerts.push({
        key: "account_snapshots_stale",
        severity: "warning",
        title: "No account context has been collected",
        evidence:
          "No follower or audience snapshot exists, so post performance cannot be put in context.",
        action: "Confirm the refresh sweep is running; account snapshots ride along with it.",
      });
    } else if (input.accountSnapshotAgeHours > ACCOUNT_SNAPSHOT_STALE_HOURS) {
      alerts.push({
        key: "account_snapshots_stale",
        severity: "info",
        title: "Account context is out of date",
        evidence: `The newest account snapshot is ${describeHours(input.accountSnapshotAgeHours)} old; they are collected daily.`,
        action: "Check the refresh sweep — account snapshots are collected inside it.",
      });
    }
  }

  return dedupe(alerts).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.key.localeCompare(b.key),
  );
}

/** One alert per key; the first (most specific) wins. */
function dedupe(alerts: readonly Alert[]): Alert[] {
  const seen = new Map<string, Alert>();
  for (const alert of alerts) {
    const key = `${alert.key}:${alert.title}`;
    if (!seen.has(key)) seen.set(key, alert);
  }
  return Array.from(seen.values());
}

function severityRank(severity: AlertSeverity): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

function describeHours(hours: number | null): string {
  if (hours == null) return "an unknown time";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function describeIso(iso: string | null): string {
  return iso ? `at ${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

/** Highest severity present, for a summary badge. */
export function worstSeverity(alerts: readonly Alert[]): AlertSeverity | null {
  if (alerts.length === 0) return null;
  return alerts.reduce<AlertSeverity>(
    (worst, a) => (severityRank(a.severity) < severityRank(worst) ? a.severity : worst),
    "info",
  );
}
