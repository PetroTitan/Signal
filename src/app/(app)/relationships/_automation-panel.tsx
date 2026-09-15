import Link from "next/link";
import type {
  CampaignSummary,
  IdentityAutomationOverview,
} from "@/core/bluesky-campaigns/load-campaign-summary.server";
import { formatIdentityLabel } from "@/core/bluesky-relationships/handle-display";

/**
 * What automatic following AND unfollowing are doing for the selected
 * identity, on the page where the work starts.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The panel showed one campaign — the most live in the workspace — and
 * so implied that was the only thing running. Two follow campaigns can
 * be active on one identity, and an unfollow campaign beside them; all
 * three share the identity's 1,000-action daily ceiling. Every live
 * campaign on the selected identity is now a card, each says which
 * kind it is, and the shared ceiling is stated once at the top.
 *
 * Reads nothing but summaries. The queues behind them may hold 100,000
 * members; none of them are loaded to draw this.
 */

const STATUS_COPY: Record<
  string,
  { label: string; tone: "running" | "attention" | "stopped" | "done" }
> = {
  active: { label: "Running", tone: "running" },
  rate_limited: { label: "Waiting — Bluesky rate limit", tone: "attention" },
  reauthorization_required: { label: "Reconnect needed", tone: "attention" },
  paused: { label: "Paused", tone: "stopped" },
  failed: { label: "Stopped after errors", tone: "attention" },
  completed: { label: "Finished", tone: "done" },
  cancelled: { label: "Cancelled", tone: "stopped" },
};

const TONE_CLASS: Record<string, string> = {
  running: "bg-emerald-50 text-emerald-700 border-emerald-200",
  attention: "bg-amber-50 text-amber-800 border-amber-200",
  stopped: "bg-ink-50 text-ink-600 border-ink-200",
  done: "bg-sky-50 text-sky-700 border-sky-200",
};

function formatNextRun(iso: string | null): string {
  if (!iso) return "Next check: shortly";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Next check: shortly";
  return `Next check: ${at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function CampaignCard({ summary }: { summary: CampaignSummary }) {
  const copy = STATUS_COPY[summary.status] ?? {
    label: summary.status,
    tone: "stopped" as const,
  };
  const percent =
    summary.total > 0
      ? Math.min(100, Math.round((summary.completed / summary.total) * 100))
      : 0;
  const verb = summary.kind === "unfollow" ? "Unfollowed" : "Followed";

  return (
    <article
      className="border border-ink-200 rounded-md p-3 sm:p-4 space-y-3"
      data-testid="automation-campaign"
      data-kind={summary.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={summary.kind === "unfollow" ? "badge-neutral" : "badge-info"}>
          {summary.kind === "unfollow" ? "Unfollow" : "Follow"}
        </span>
        <h3 className="text-sm font-semibold text-ink-900 break-words min-w-0">
          {summary.name}
        </h3>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
            TONE_CLASS[copy.tone]
          }`}
        >
          {copy.label}
        </span>
        {summary.dryRun ? <span className="badge-info">Dry run — sends nothing</span> : null}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-ink-600">
            {summary.completed.toLocaleString()} of {summary.total.toLocaleString()} profiles done
          </span>
          <span className="text-ink-500 tabular-nums">{percent}%</span>
        </div>
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink-100"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${summary.name} progress`}
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="stat-label">Tried today</dt>
          <dd className="text-sm text-ink-900 tabular-nums">{summary.attemptedToday.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="stat-label">{verb} today</dt>
          <dd className="text-sm text-ink-900 tabular-nums">{summary.succeededToday.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="stat-label">Failed today</dt>
          <dd className="text-sm text-ink-900 tabular-nums">{summary.failedToday.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="stat-label">You asked for</dt>
          <dd className="text-sm text-ink-900 tabular-nums">{summary.requestedDailyQuota.toLocaleString()}/day</dd>
        </div>
        <div className="col-span-2">
          <dt className="stat-label">Today&apos;s limit</dt>
          <dd className="text-sm text-ink-900">
            <span className="tabular-nums">{summary.effectiveDailyQuota.toLocaleString()}</span>
            {summary.effectiveQuotaReason ? (
              <span className="text-ink-500"> — {summary.effectiveQuotaReason}</span>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-500">{formatNextRun(summary.nextRunAt)}</p>
        <Link href={summary.href} className="btn-secondary min-h-11 inline-flex items-center">
          Open campaign
        </Link>
      </div>
    </article>
  );
}

export function AutomationPanel({ overview }: { overview: IdentityAutomationOverview }) {
  const identity = formatIdentityLabel({
    id: overview.identityId,
    handle: overview.identityHandle,
    displayName: overview.identityDisplayName,
  });
  const n = overview.campaigns.length;

  return (
    <section
      className="card card-padded space-y-4"
      aria-label="Automatic campaigns for this identity"
      data-testid="automation-panel"
    >
      <div>
        <h2 className="section-title break-words">
          {n === 0 ? (
            "Nothing running for this identity"
          ) : (
            <>
              {n} {n === 1 ? "campaign" : "campaigns"} running as{" "}
              <span className="break-all">{identity}</span>
            </>
          )}
        </h2>
        <p className="mt-1 text-sm text-ink-600 leading-relaxed" data-testid="shared-ceiling">
          Every campaign acting as this account shares one daily ceiling of{" "}
          <strong>{overview.ceiling.toLocaleString()} actions</strong> — follows and unfollows
          together. Used today: {overview.attemptsToday.toLocaleString()} (
          {overview.followsToday.toLocaleString()} follows, {overview.unfollowsToday.toLocaleString()}{" "}
          unfollows). A campaign&apos;s daily number is what it may take from that ceiling, not a
          promise.
        </p>
        {overview.otherIdentitiesLive > 0 ? (
          <p className="mt-1 text-sm text-ink-500 leading-relaxed">
            {overview.otherIdentitiesLive === 1
              ? "One other identity in this workspace also has a running campaign"
              : `${overview.otherIdentitiesLive} other identities in this workspace also have running campaigns`}{" "}
            — see{" "}
            <Link
              href="/relationships/campaigns"
              className="underline inline-flex items-center min-h-11"
            >
              all campaigns
            </Link>
            .
          </p>
        ) : null}
      </div>

      {n > 0 ? (
        <div className="space-y-3">
          {overview.campaigns.map((c) => (
            <CampaignCard key={c.id} summary={c} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The call to action when nothing is running yet.
 *
 * Deliberately on the page itself and in the header, not behind a nav
 * sheet: an operator who has just imported a list should not have to
 * discover a separate section to act on it.
 */
export function StartAutomationCta({
  canManage,
  compact = false,
}: {
  canManage: boolean;
  compact?: boolean;
}) {
  if (!canManage) return null;
  return (
    <Link
      href="/relationships/campaigns/setup"
      className={`btn-primary inline-flex items-center justify-center min-h-11 ${
        compact ? "" : "w-full sm:w-auto"
      }`}
      data-testid="start-automatic-following"
    >
      Start automatic following
    </Link>
  );
}

/**
 * The primary route into bulk unfollowing.
 *
 * Sits in the page HEADER beside "Start automatic following", so it is
 * on screen on a 320px phone without opening any secondary navigation.
 *
 * `btn-secondary`, not `btn-primary`. Both are primary ACTIONS on this
 * page, but only one of them is irreversible, and the visual weight
 * should not invite it.
 */
export function StartUnfollowCta({
  canManage,
  compact = false,
}: {
  canManage: boolean;
  compact?: boolean;
}) {
  if (!canManage) return null;
  return (
    <Link
      href="/relationships/unfollow"
      className={`btn-secondary inline-flex items-center justify-center min-h-11 ${
        compact ? "" : "w-full sm:w-auto"
      }`}
      data-testid="start-automatic-unfollowing"
    >
      Unfollow people…
    </Link>
  );
}
