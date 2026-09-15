import Link from "next/link";
import type { UnfollowCampaignDetail } from "@/core/bluesky-unfollow/load-detail.server";
import { CampaignControls } from "./_controls";

/**
 * The unfollow campaign dashboard — a campaign that already exists,
 * described from the database, with the controls to change what it
 * does next.
 *
 * NOT A SETUP FORM. Nothing here is an input that pretends to edit a
 * created campaign: the quota, the source, the window and the dry-run
 * flag are facts, rendered as facts. Production opened this route and
 * found a wizard with default values; this is what it opens now.
 *
 * Every count is one of the frozen queue's members in exactly one
 * category. "Simulated" is its own category so a dry run is never
 * mistaken for a provider rejection or an ordinary skip.
 *
 * A server component with no state, so the browser sweep can render it
 * with hostile data through the same code the page uses.
 */

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  building_queue: "Building the list",
  ready: "Ready to start",
  active: "Unfollowing automatically",
  paused: "Paused",
  rate_limited: "Waiting — Bluesky rate limit",
  reauthorization_required: "Reconnect needed",
  failed: "Stopped — needs review",
  completed: "Finished",
  cancelled: "Cancelled",
};

const STATUS_BADGE: Record<string, string> = {
  active: "badge-low",
  rate_limited: "badge-medium",
  reauthorization_required: "badge-medium",
  failed: "badge-high",
  completed: "badge-info",
};

const MEMBER_STATE_COPY: Record<string, { label: string; hint: string }> = {
  queued: { label: "Waiting", hint: "Not reached yet." },
  claimed: { label: "Picked up", hint: "A worker has it." },
  running: { label: "Sent to Bluesky", hint: "A request is outstanding." },
  succeeded: { label: "Unfollowed", hint: "The follow record was deleted." },
  already_not_following: {
    label: "Already not following",
    hint: "Nothing to delete. No daily allowance was used.",
  },
  protected: { label: "Protected", hint: "Skipped on purpose." },
  skipped: { label: "Skipped", hint: "Nothing was sent." },
  retryable: { label: "Waiting to retry", hint: "Will be tried again, or confirmed by a read, later." },
  failed_structural: { label: "Failed", hint: "Bluesky rejected it. Will not be retried." },
  cancelled: { label: "Cancelled", hint: "You stopped this campaign." },
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="stat-label">{label}</dt>
      <dd className="text-sm text-ink-900 break-words">{value}</dd>
      {hint ? <dd className="text-xs text-ink-500 break-words">{hint}</dd> : null}
    </div>
  );
}

export function UnfollowCampaignDetailView({
  detail,
  canManage,
}: {
  detail: UnfollowCampaignDetail;
  canManage: boolean;
}) {
  const d = detail;
  const href = (params: Record<string, string | number | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
    }
    const s = q.toString();
    return `/relationships/unfollow/${d.id}${s ? `?${s}` : ""}`;
  };
  const filters: { value: string | null; label: string }[] = [
    { value: null, label: "All" },
    { value: "queued", label: "Waiting" },
    { value: "retryable", label: "Retrying / checking" },
    { value: "succeeded", label: "Unfollowed" },
    { value: "already_not_following", label: "Already not following" },
    { value: "protected", label: "Protected" },
    { value: "skipped", label: d.dryRun ? "Simulated" : "Skipped" },
    { value: "failed_structural", label: "Failed" },
  ];

  return (
    <div className="space-y-4" data-testid="unfollow-campaign-detail">
      <p className="text-sm text-ink-700">
        <Link
          href="/relationships/campaigns?kind=unfollow"
          className="underline inline-flex items-center min-h-11"
        >
          ← All campaigns
        </Link>
      </p>

      {/* ── Identity of the campaign ─────────────────────────────── */}
      <section className="card card-padded space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink-900 break-words min-w-0">{d.name}</h2>
          <span className="badge-neutral">Unfollow campaign</span>
          <span className={STATUS_BADGE[d.status] ?? "badge-neutral"} data-testid="campaign-status">
            {STATUS_LABEL[d.status] ?? d.status.replace(/_/g, " ")}
          </span>
          {d.dryRun ? (
            <span className="badge-info" data-testid="dry-run-badge">
              Dry run — nothing is sent
            </span>
          ) : null}
        </div>
        <p className="text-sm text-ink-600 leading-relaxed break-words">
          Acting as <span className="font-medium text-ink-900 break-all">{d.identityLabel}</span>.
          Unfollowing removes a public relationship; nothing here re-follows anyone.
        </p>

        {d.status === "reauthorization_required" ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed">
            Bluesky no longer accepts this account&rsquo;s session. Reconnect it on Accounts;
            Signal resumes on its own once the session works.
          </p>
        ) : null}
        {d.status === "rate_limited" ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed">
            Bluesky rate-limited this account. Nothing will be sent before {fmt(d.rateLimitedUntil)}.
            This resumes on its own.
          </p>
        ) : null}

        <p className="text-sm text-ink-800 bg-ink-50 border border-ink-200 rounded-md p-3 leading-relaxed">
          Signal will continue processing all{" "}
          <strong>{d.queueSize.toLocaleString()}</strong> profiles
          automatically across future days until every profile has a confirmed
          outcome. The daily quota limits daily work, not the campaign size.
        </p>
      </section>

      {/* ── What this campaign IS ─────────────────────────────────── */}
      <section className="card card-padded space-y-4">
        <h2 className="section-title">Configuration</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Stat
            label="Source (frozen when the list was built)"
            value={d.sourceTargetLabel ? `${d.sourceLabel}: ${d.sourceTargetLabel}` : d.sourceLabel}
            hint={`Stored as "${d.sourceKind}"${d.sourceFrozen ? "" : " — still building"}`}
          />
          <Stat label="Queue size" value={`${d.queueSize.toLocaleString()} profiles`} />
          <Stat label="Time zone" value={d.timezone} />
          <Stat label="Time of day" value={`${d.windowLabel} local`} />
          <Stat label="You asked for" value={`${d.requestedDailyQuota.toLocaleString()} a day`} />
          <Stat
            label="Signal may do today"
            value={`${d.effectiveDailyQuota.toLocaleString()} a day`}
            hint={d.effectiveQuotaReason ?? undefined}
          />
          <Stat
            label="This account today (shared)"
            value={`${d.identityMutationsToday.toLocaleString()} of ${d.identityCeiling.toLocaleString()} actions`}
            hint={`${d.identityFollowsToday.toLocaleString()} follows + ${d.identityUnfollowsToday.toLocaleString()} unfollows — ${d.identityPointsToday.toLocaleString()} Bluesky points. The ${d.identityCeiling.toLocaleString()}-action ceiling is shared by every campaign acting as this account.`}
          />
          <Stat
            label="Never-unfollow list"
            value={`${d.allowlistCount.toLocaleString()} ${d.allowlistCount === 1 ? "entry" : "entries"} apply`}
          />
        </dl>
      </section>

      {/* ── Progress ──────────────────────────────────────────────── */}
      <section className="card card-padded space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-title">Progress</h2>
          <span className="text-sm text-ink-600 tabular-nums" data-testid="progress-percent">
            {d.progressPercent}% of {d.total.toLocaleString()} have a confirmed outcome
          </span>
        </div>
        <div
          className="h-2 w-full rounded-full bg-ink-100 overflow-hidden"
          role="progressbar"
          aria-valuenow={d.progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Campaign progress"
        >
          <div className="h-full bg-ink-900" style={{ width: `${d.progressPercent}%` }} />
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <Stat label="Waiting" value={d.queued.toLocaleString()} />
          <Stat label="Processed" value={d.processed.toLocaleString()} hint="Reached at least once." />
          <Stat label="Unfollowed" value={d.succeeded.toLocaleString()} hint="Follow record deleted." />
          <Stat label="Already not following" value={d.alreadyNotFollowing.toLocaleString()} />
          <Stat label="Protected" value={d.protectedCount.toLocaleString()} hint="With the reason, below." />
          <Stat label="Retrying" value={d.retrying.toLocaleString()} hint="Transient error; bounded backoff." />
          <Stat
            label="Reconciliation required"
            value={d.reconciling.toLocaleString()}
            hint="Outcome unknown; settled by reading Bluesky, never by re-sending."
          />
          <Stat label="Failed (structural)" value={d.failed.toLocaleString()} hint="Rejected by Bluesky; not retried." />
          {d.dryRun || d.simulated > 0 ? (
            <Stat
              label="Simulated (dry run)"
              value={d.simulated.toLocaleString()}
              hint="Went through every step; nothing was sent."
            />
          ) : null}
          {Object.entries(d.skippedByReason).map(([code, n]) => (
            <Stat key={code} label={`Skipped: ${code.replace(/_/g, " ")}`} value={n.toLocaleString()} />
          ))}
          <Stat label="Cancelled" value={d.cancelled.toLocaleString()} />
          <Stat label="Remaining" value={d.remaining.toLocaleString()} hint="Still to be processed." />
        </dl>
        <p className="text-sm text-ink-600 leading-relaxed" data-testid="estimate">
          {d.estimatedDays !== null ? (
            <>
              <strong>Estimated {d.estimatedDays.toLocaleString()} more {d.estimatedDays === 1 ? "day" : "days"}.</strong>{" "}
              An estimate, not a promise: what Signal may do each day is recalculated daily from
              this account&rsquo;s remaining allowance and anything Bluesky tells us, and a day
              may carry fewer than {d.requestedDailyQuota.toLocaleString()} across its deliveries.
            </>
          ) : (
            "How long this takes cannot be estimated yet."
          )}
        </p>
      </section>

      {/* ── Schedule ──────────────────────────────────────────────── */}
      <section className="card card-padded space-y-3">
        <h2 className="section-title">Schedule</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Next scheduled run" value={d.nextRunAt ? fmt(d.nextRunAt) : "Not scheduled"} />
          <Stat label="Last successful action" value={fmt(d.lastSuccessAt)} />
        </dl>
        {d.latestRun ? (
          <div data-testid="latest-run">
            <h3 className="stat-label">Latest run — {d.latestRun.localDate}</h3>
            <p className="text-sm text-ink-800 leading-relaxed">
              {d.latestRun.status.replace(/_/g, " ")} · attempted {d.latestRun.attempted.toLocaleString()} ·
              unfollowed {d.latestRun.succeeded.toLocaleString()} · already absent{" "}
              {d.latestRun.alreadyAbsent.toLocaleString()} · protected {d.latestRun.protectedCount.toLocaleString()} ·
              failed {d.latestRun.failed.toLocaleString()} · awaiting confirmation{" "}
              {d.latestRun.reconciliationRequired.toLocaleString()} · allowed {d.latestRun.effectiveDailyQuota.toLocaleString()}
              {d.latestRun.effectiveQuotaReason ? ` (${d.latestRun.effectiveQuotaReason})` : ""}
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-600">No run yet.</p>
        )}
      </section>

      {/* ── Control ───────────────────────────────────────────────── */}
      <section className="card card-padded space-y-4">
        <h2 className="section-title">Control</h2>
        <p className="text-sm text-ink-700 leading-relaxed">
          Pausing or cancelling stops future work.{" "}
          <strong>Cancel does not re-follow anyone already unfollowed</strong> — Signal has no way
          to undo an unfollow, and offering one would be a second mass action pretending to be a
          safety feature.
        </p>
        <CampaignControls
          campaignId={d.id}
          identityId={d.identityId}
          identityLabel={d.identityLabel}
          status={d.status}
          canManage={canManage}
          unresolvedCount={d.reconciling}
        />
        {d.lastErrorMessage ? (
          <div>
            <h3 className="stat-label">Recent error</h3>
            <p className="text-sm text-ink-800 break-words leading-relaxed">{d.lastErrorMessage}</p>
          </div>
        ) : null}
      </section>

      {/* ── Run history ───────────────────────────────────────────── */}
      <section className="card card-padded space-y-3">
        <h2 className="section-title">Run history</h2>
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-sm min-w-[40rem]" data-testid="run-history">
            <thead>
              <tr className="text-left">
                <th className="stat-label py-2 pr-3">Day</th>
                <th className="stat-label py-2 pr-3">Status</th>
                <th className="stat-label py-2 pr-3">Attempted</th>
                <th className="stat-label py-2 pr-3">Unfollowed</th>
                <th className="stat-label py-2 pr-3">Already absent</th>
                <th className="stat-label py-2 pr-3">Failed</th>
                <th className="stat-label py-2">Awaiting</th>
              </tr>
            </thead>
            <tbody>
              {d.runs.map((r) => (
                <tr key={r.id} className="border-t border-ink-100 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{r.localDate}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{r.status.replace(/_/g, " ")}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.attempted.toLocaleString()}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.succeeded.toLocaleString()}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.alreadyAbsent.toLocaleString()}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.failed.toLocaleString()}</td>
                  <td className="py-2 tabular-nums">{r.reconciliationRequired.toLocaleString()}</td>
                </tr>
              ))}
              {d.runs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-3 text-ink-600">No runs yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {d.runsNextCursor ? (
          <Link
            href={href({ runs_before: d.runsNextCursor, status: d.memberFilter })}
            className="btn-secondary min-h-11 inline-flex items-center"
          >
            Older runs
          </Link>
        ) : null}
      </section>

      {/* ── The queue ─────────────────────────────────────────────── */}
      <section className="card card-padded space-y-3">
        <div className="flex flex-wrap gap-2 items-baseline justify-between">
          <h2 className="section-title">Profiles</h2>
          <span className="text-sm text-ink-600">
            {d.total.toLocaleString()} in the frozen list
          </span>
        </div>
        <nav aria-label="Filter profiles" className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
          <ul className="flex gap-2 list-none p-0 m-0 w-max min-w-full">
            {filters.map((fl) => (
              <li key={fl.label}>
                <Link
                  href={href({ status: fl.value })}
                  aria-current={(d.memberFilter ?? null) === fl.value ? "page" : undefined}
                  className={`btn min-h-11 inline-flex items-center whitespace-nowrap ${
                    (d.memberFilter ?? null) === fl.value ? "nav-item-active border-signal-300" : ""
                  }`}
                >
                  {fl.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-sm min-w-[32rem]" data-testid="member-queue">
            <thead>
              <tr className="text-left">
                <th className="stat-label py-2 pr-3">#</th>
                <th className="stat-label py-2 pr-3">Profile</th>
                <th className="stat-label py-2 pr-3">Outcome</th>
                <th className="stat-label py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {d.members.map((m) => {
                const copy = MEMBER_STATE_COPY[m.status] ?? { label: m.status, hint: "" };
                return (
                  <tr key={m.id} className="border-t border-ink-100 align-top">
                    <td className="py-2 pr-3 tabular-nums text-ink-500">{m.sequence}</td>
                    <td className="py-2 pr-3 break-all">
                      {m.handle ? `@${m.handle.replace(/^@+/, "")}` : m.subjectDid}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {m.simulated ? (
                        <span className="badge-info" data-testid="simulated-outcome">
                          Simulated (dry run)
                        </span>
                      ) : (
                        copy.label
                      )}
                    </td>
                    <td className="py-2 text-ink-600 break-words">
                      {m.reasonLabel ??
                        (m.status === "retryable" && m.nextAttemptAt
                          ? `${copy.hint} Next check ${fmt(m.nextAttemptAt)}.`
                          : m.lastErrorMessage ?? copy.hint)}
                    </td>
                  </tr>
                );
              })}
              {d.members.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-ink-600">Nothing to show.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {d.membersNextCursor !== null ? (
          <Link
            href={href({ after: d.membersNextCursor, status: d.memberFilter })}
            className="btn-secondary min-h-11 inline-flex items-center"
          >
            Next {d.members.length} profiles
          </Link>
        ) : null}
      </section>
    </div>
  );
}
