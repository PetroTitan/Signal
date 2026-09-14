import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { loadUnfollowCampaignDetail } from "@/core/bluesky-unfollow/load-detail.server";
import { CampaignControls } from "./_controls";

export const dynamic = "force-dynamic";

/**
 * One unfollow campaign, in full.
 *
 * Every number on this page comes from an exact database count or from
 * today's run row. A campaign may hold 100,000 members; none of them
 * are loaded to draw the summary, and the member list below is one
 * bounded page.
 *
 * The member states are shown as DISTINCT outcomes rather than rolled
 * into "done": "already not following" is a neutral success that cost
 * nothing, "protected" carries the reason it was skipped, and
 * "checking with Bluesky" means a public request whose outcome is
 * genuinely unknown. Collapsing those would tell an operator that
 * something happened when it did not.
 */

const STATE_COPY: Record<string, { label: string; hint: string }> = {
  queued: { label: "Waiting", hint: "Not reached yet." },
  claimed: { label: "Picked up", hint: "A worker has it." },
  provider_in_flight: {
    label: "Sent to Bluesky",
    hint: "A request is outstanding.",
  },
  succeeded: { label: "Unfollowed", hint: "The follow record was deleted." },
  already_not_following: {
    label: "Already not following",
    hint: "Nothing to delete. No daily allowance was used.",
  },
  protected: { label: "Protected", hint: "Skipped on purpose." },
  skipped: { label: "Skipped", hint: "Nothing was sent." },
  retryable: {
    label: "Checking with Bluesky",
    hint: "Will be tried again, or confirmed, later.",
  },
  failed_structural: { label: "Failed", hint: "Will not be retried." },
  cancelled: { label: "Cancelled", hint: "You stopped this campaign." },
};

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Topbar title={title} description="Automatic unfollowing" />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">{children}</div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="stat-label">{label}</dt>
      <dd className="text-sm text-ink-900 break-words">{value}</dd>
    </div>
  );
}

export default async function UnfollowCampaignPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { page?: string; status?: string };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Shell title="Unfollow campaign">
        <div className="card card-padded">
          <p className="text-sm text-ink-600">Connect Supabase first.</p>
        </div>
      </Shell>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) notFound();

  const detail = await loadUnfollowCampaignDetail({
    workspaceId: membership.workspace.id,
    campaignId: params.id,
    page: Number(searchParams?.page ?? 1) || 1,
    statusFilter: searchParams?.status ?? null,
  });
  if (!detail) notFound();

  const canManage = can(membership.role, "connect_platforms");
  const percent =
    detail.total > 0
      ? Math.min(
          100,
          Math.round(((detail.total - detail.remaining) / detail.total) * 100),
        )
      : 0;

  return (
    <Shell title={detail.name}>
      <div className="space-y-4">
        <p className="text-sm text-ink-700">
          <Link href="/relationships/unfollow" className="underline">
            Back to unfollow setup
          </Link>
        </p>

        {detail.dryRun ? (
          <p className="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-md p-3 leading-relaxed">
            <strong>Dry run.</strong> Every step runs and nothing is sent to
            Bluesky. No follow record is deleted.
          </p>
        ) : null}

        {detail.status === "reauthorization_required" ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed">
            Bluesky no longer accepts this account&rsquo;s session. Reconnect it
            on Accounts, then resume. Nothing is being sent meanwhile.
          </p>
        ) : null}

        {detail.status === "rate_limited" ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed">
            Bluesky rate-limited this account. Nothing will be sent before{" "}
            {detail.rateLimitedUntil ?? "its reset"}. This resumes on its own.
          </p>
        ) : null}

        {/* ── What this campaign IS ─────────────────────────────── */}
        <section className="card card-padded space-y-4">
          <div className="flex flex-wrap gap-2 items-baseline">
            <h2 className="section-title">Overview</h2>
            <span className="badge-info">
              {detail.status.replace(/_/g, " ")}
            </span>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Acting as" value={detail.identityLabel} />
            <Stat
              label="Source (frozen)"
              value={
                detail.sourceFrozen
                  ? detail.sourceLabel
                  : `${detail.sourceLabel} — still building`
              }
            />
            <Stat label="Queue size" value={detail.queueSize.toLocaleString()} />
            <Stat
              label="You asked for"
              value={`${detail.requestedDailyQuota.toLocaleString()} a day`}
            />
            <Stat
              label="Signal may do today"
              value={`${detail.effectiveDailyQuota.toLocaleString()} a day`}
            />
            <Stat
              label="Time of day"
              value={`${detail.windowLabel} (${detail.timezone})`}
            />
            <Stat
              label="This account today"
              value={`${detail.identityMutationsToday.toLocaleString()} of ${detail.identityCeiling.toLocaleString()} actions — ${detail.identityPointsToday.toLocaleString()} Bluesky points`}
            />
            <Stat
              label="Next scheduled run"
              value={detail.nextRunAt ?? "Not scheduled"}
            />
            <Stat
              label="Last successful action"
              value={detail.lastSuccessAt ?? "None yet"}
            />
            <Stat
              label="Estimate"
              value={
                detail.estimatedDays !== null
                  ? `About ${detail.estimatedDays.toLocaleString()} days — an estimate, recalculated daily`
                  : "Not estimable"
              }
            />
          </dl>
          {detail.effectiveQuotaReason ? (
            <p className="text-sm text-ink-700 bg-ink-50 border border-ink-200 rounded-md p-3 leading-relaxed">
              {detail.effectiveQuotaReason}
            </p>
          ) : null}
        </section>

        {/* ── Today ─────────────────────────────────────────────── */}
        <section className="card card-padded space-y-3">
          <h2 className="section-title">Today</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <Stat label="Attempted" value={detail.todayAttempted.toLocaleString()} />
            <Stat label="Unfollowed" value={detail.todaySucceeded.toLocaleString()} />
            <Stat
              label="Already not following"
              value={detail.todayAlreadyAbsent.toLocaleString()}
            />
            <Stat label="Protected" value={detail.todayProtected.toLocaleString()} />
            <Stat label="Failed" value={detail.todayFailed.toLocaleString()} />
            <Stat
              label="Awaiting confirmation"
              value={detail.todayReconciliationRequired.toLocaleString()}
            />
          </dl>
        </section>

        {/* ── Overall ───────────────────────────────────────────── */}
        <section className="card card-padded space-y-3">
          <h2 className="section-title">Progress</h2>
          <div
            className="h-2 w-full rounded-full bg-ink-100 overflow-hidden"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Campaign progress"
          >
            <div
              className="h-full bg-ink-900"
              style={{ width: `${percent}%` }}
            />
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <Stat label="Unfollowed" value={detail.succeeded.toLocaleString()} />
            <Stat
              label="Already not following"
              value={detail.alreadyNotFollowing.toLocaleString()}
            />
            <Stat label="Protected" value={detail.protectedCount.toLocaleString()} />
            <Stat label="Failed" value={detail.failed.toLocaleString()} />
            <Stat label="Cancelled" value={detail.cancelled.toLocaleString()} />
            <Stat label="Remaining" value={detail.remaining.toLocaleString()} />
          </dl>
        </section>

        {/* ── Control ───────────────────────────────────────────── */}
        <section className="card card-padded space-y-4">
          <h2 className="section-title">Control</h2>
          <CampaignControls
            campaignId={detail.id}
            identityId={detail.identityId}
            identityLabel={detail.identityLabel}
            status={detail.status}
            canManage={canManage}
          />
          {detail.lastErrorMessage ? (
            <div>
              <h3 className="stat-label">Recent error</h3>
              <p className="text-sm text-ink-800 break-words leading-relaxed">
                {detail.lastErrorMessage}
              </p>
            </div>
          ) : null}
        </section>

        {/* ── The queue ─────────────────────────────────────────── */}
        <section className="card card-padded space-y-3">
          <div className="flex flex-wrap gap-2 items-baseline justify-between">
            <h2 className="section-title">Profiles</h2>
            <span className="text-sm text-ink-600">
              {detail.memberPage.total.toLocaleString()} shown by this filter
            </span>
          </div>

          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm min-w-[32rem]">
              <thead>
                <tr className="text-left">
                  <th className="stat-label py-2 pr-3">Profile</th>
                  <th className="stat-label py-2 pr-3">Outcome</th>
                  <th className="stat-label py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => {
                  const copy = STATE_COPY[m.status] ?? {
                    label: m.status,
                    hint: "",
                  };
                  return (
                    <tr key={m.id} className="border-t border-ink-100 align-top">
                      <td className="py-2 pr-3 break-all">
                        {m.handle ? `@${m.handle}` : m.subjectDid}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {copy.label}
                      </td>
                      <td className="py-2 text-ink-600 break-words">
                        {m.protectedReason ??
                          m.lastErrorMessage ??
                          copy.hint}
                      </td>
                    </tr>
                  );
                })}
                {detail.members.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-3 text-ink-600">
                      Nothing to show.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {detail.memberPage.totalPages > 1 ? (
            <div className="flex flex-wrap gap-2">
              {detail.memberPage.page > 1 ? (
                <Link
                  href={`/relationships/unfollow/${detail.id}?page=${detail.memberPage.page - 1}`}
                  className="btn-secondary min-h-11 inline-flex items-center"
                >
                  Previous
                </Link>
              ) : null}
              {detail.memberPage.page < detail.memberPage.totalPages ? (
                <Link
                  href={`/relationships/unfollow/${detail.id}?page=${detail.memberPage.page + 1}`}
                  className="btn-secondary min-h-11 inline-flex items-center"
                >
                  Next
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
