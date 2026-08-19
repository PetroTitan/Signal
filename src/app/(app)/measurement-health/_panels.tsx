import type { Alert, AlertSeverity } from "@/core/metrics/health/alerts";
import type { ProviderHealth, RefreshHealthState } from "@/core/metrics/health/refresh-health";
import type { CoverageSummary } from "@/core/metrics/coverage";
import type { AccountContextView } from "@/core/metrics/health/load-measurement-status.server";
import { emptyState } from "@/core/metrics/health/empty-states";
import { platformLabel } from "@/core/metrics/metric-availability";

/**
 * Presentational pieces of the measurement-health surface, split out so
 * they can be rendered in a node-environment test. This is operational
 * infrastructure, not analytics: every element answers "what is the
 * state, and what do I do about it".
 */

export const HEALTH_LABEL: Record<RefreshHealthState, string> = {
  healthy: "Working",
  degraded: "Partly working",
  stale: "Out of date",
  never_run: "Never run",
  rate_limited: "Rate limited",
  provider_error: "Provider failing",
  configuration_error: "Not configured",
  database_error: "Database unreachable",
};

export const HEALTH_BADGE: Record<RefreshHealthState, string> = {
  healthy: "badge badge-low",
  degraded: "badge badge-medium",
  stale: "badge badge-medium",
  never_run: "badge badge-info",
  rate_limited: "badge badge-info",
  provider_error: "badge badge-high",
  configuration_error: "badge badge-high",
  database_error: "badge badge-high",
};

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "badge badge-high",
  warning: "badge badge-medium",
  info: "badge badge-info",
};

export function AlertRow({ alert }: { alert: Alert }) {
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={SEVERITY_BADGE[alert.severity]}>{alert.severity}</span>
        <p className="text-sm font-medium text-ink-900 leading-relaxed min-w-0">
          {alert.title}
        </p>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">{alert.evidence}</p>
      <p className="text-sm text-ink-900 mt-1 leading-relaxed">{alert.action}</p>
    </li>
  );
}

export function ProviderRow({ provider }: { provider: ProviderHealth }) {
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label">{platformLabel(provider.platform)}</span>
        <span className={HEALTH_BADGE[provider.state]}>
          {HEALTH_LABEL[provider.state]}
        </span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">{provider.evidence}</p>
      <p className="text-[11px] text-ink-400 mt-1">
        last successful read:{" "}
        {provider.lastSuccessfulReadAt
          ? provider.lastSuccessfulReadAt.slice(0, 16).replace("T", " ") + " UTC"
          : "never"}
      </p>
    </li>
  );
}

export function CoverageRow({ platform }: { platform: CoverageSummary }) {
  const backfill = platform.backfillRecoverable > 0 ? emptyState("backfill_not_run") : null;
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label">{platformLabel(platform.platform)}</span>
        <span className="stat-value">
          {platform.coveragePercent == null
            ? emptyState("no_publications").label
            : `${platform.postsWithFreshSnapshots} / ${platform.measurablePosts}`}
        </span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">{platform.summary}</p>
      {backfill ? (
        <p className="text-sm text-ink-900 mt-1 leading-relaxed">{backfill.action}</p>
      ) : null}
      <p className="text-[11px] text-ink-400 mt-1">
        {platform.publishAttempts} attempt(s) · {platform.publishedPosts} published ·
        blocked and failed attempts are excluded
      </p>
    </li>
  );
}

export function AccountRow({ account }: { account: AccountContextView }) {
  const unread = account.followers == null;
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label">
          {platformLabel(account.platform)}
          {account.handle ? ` · ${account.handle}` : ""}
        </span>
        <span className="stat-value">
          {unread ? emptyState("never_measured").label : `${account.followers} followers`}
        </span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">
        {unread
          ? emptyState("never_measured").message
          : `${account.following ?? "unknown"} following · ${account.postCount ?? "unknown"} posts on the platform.`}
      </p>
      <p className="text-[11px] text-ink-400 mt-1">
        {account.fetchedAt
          ? `read ${account.ageHours != null ? `${Math.round(account.ageHours)}h ago` : "at an unknown time"} · ${account.freshness}`
          : emptyState("never_measured").label}
        {account.error ? ` · ${account.error}` : ""}
      </p>
    </li>
  );
}
