import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadMeasurementStatus } from "@/core/metrics/health/load-measurement-status.server";
import { emptyState } from "@/core/metrics/health/empty-states";
import {
  AccountRow,
  AlertRow,
  CoverageRow,
  HEALTH_BADGE,
  HEALTH_LABEL,
  ProviderRow,
} from "./_panels";

export const dynamic = "force-dynamic";

/**
 * Social measurement health.
 *
 * Operational infrastructure, not another analytics dashboard. It answers
 * one question — is measurement working, and if not what is broken — and
 * every empty cell says WHICH kind of empty it is.
 */
export default async function MeasurementHealthPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Measurement health" description="Whether social measurement is working." />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">Connect Supabase to read measurement state.</p>
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Measurement health" description="Whether social measurement is working." />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">No workspace is available for this account.</p>
          </div>
        </div>
      </>
    );
  }

  const status = await loadMeasurementStatus(membership.workspace.id);
  const { health } = status;

  return (
    <>
      <Topbar
        title="Measurement health"
        description="Whether Signal is actually measuring what it published — and if not, what is broken and why."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6">
        {/* System */}
        <section className="card card-padded space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="section-title">Measurement system</h2>
            <span className={HEALTH_BADGE[health.overall]}>{HEALTH_LABEL[health.overall]}</span>
          </div>
          <p className="text-sm text-ink-600 leading-relaxed">{health.summary}</p>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <dt className="stat-label">Last run</dt>
              <dd className="text-sm text-ink-900 break-words">
                {health.lastRunAt
                  ? `${health.lastRunAt.slice(0, 16).replace("T", " ")} UTC`
                  : emptyState("never_measured").label}
              </dd>
            </div>
            <div>
              <dt className="stat-label">Last successful run</dt>
              <dd className="text-sm text-ink-900 break-words">
                {health.lastSuccessfulRunAt
                  ? `${health.lastSuccessfulRunAt.slice(0, 16).replace("T", " ")} UTC`
                  : emptyState("never_measured").label}
              </dd>
            </div>
          </dl>

          {health.lastZeroReason ? (
            <p className="text-sm text-ink-600 leading-relaxed">
              The last run measured nothing: <span className="font-medium">{health.lastZeroReason}</span>.
            </p>
          ) : null}

          <ul className="text-sm text-ink-600 space-y-1 leading-relaxed">
            {health.evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {!health.everRan ? (
            <p className="text-sm text-ink-900 leading-relaxed">
              {emptyState("never_measured").message}{" "}
              {emptyState("never_measured").action}
            </p>
          ) : null}
        </section>

        {/* Alerts */}
        {status.alerts.length > 0 ? (
          <section className="card card-padded">
            <h2 className="section-title">Needs attention</h2>
            <ul className="list-none p-0 m-0 mt-2">
              {status.alerts.map((alert) => (
                <AlertRow key={`${alert.key}-${alert.title}`} alert={alert} />
              ))}
            </ul>
          </section>
        ) : null}

        {/* Providers */}
        <section className="card card-padded">
          <h2 className="section-title">Providers</h2>
          <ul className="list-none p-0 m-0 mt-2">
            {health.providers.map((provider) => (
              <ProviderRow key={provider.platform} provider={provider} />
            ))}
          </ul>
        </section>

        {/* Coverage */}
        <section className="card card-padded">
          <h2 className="section-title">Post coverage</h2>
          {status.empty ? (
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              {emptyState("no_publications").message}
            </p>
          ) : (
            <ul className="list-none p-0 m-0 mt-2">
              {status.coverage.map((platform) => (
                <CoverageRow key={platform.platform} platform={platform} />
              ))}
            </ul>
          )}
          <p className="text-[11px] text-ink-400 mt-3 leading-relaxed">
            Next sweep: {status.plan.summary}
          </p>
        </section>

        {/* Account context */}
        <section className="card card-padded">
          <h2 className="section-title">Account context</h2>
          {status.accounts.length === 0 ? (
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              {emptyState("never_measured").message}
            </p>
          ) : (
            <ul className="list-none p-0 m-0 mt-2">
              {status.accounts.map((account) => (
                <AccountRow key={account.accountId} account={account} />
              ))}
            </ul>
          )}
        </section>

        {/* Backfill + budget */}
        <section className="card card-padded space-y-2">
          <h2 className="section-title">Historical backfill</h2>
          <p className="text-sm text-ink-600 leading-relaxed">
            {status.plan.backfillOnly.length === 0
              ? "No publication is waiting on a backfill."
              : `${status.plan.backfillOnly.length} publication(s) predate the enrolment window. ${emptyState("backfill_not_run").action}`}
          </p>
          <p className="text-[11px] text-ink-400 leading-relaxed">
            X read budget today: {status.budget.spentToday} of {status.budget.limit} resource(s) used.
            A backfill previews its resource count and cost before it runs, and refuses if the cost
            cannot be established.
          </p>
          <Link href="/account-health" className="btn-ghost inline-flex text-ink-500">
            See audience and content signals
          </Link>
        </section>
      </div>
    </>
  );
}
