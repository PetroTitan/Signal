import Link from "next/link";
import type { CampaignSummary } from "@/core/bluesky-campaigns/load-campaign-summary.server";
import { formatIdentityLabel } from "@/core/bluesky-relationships/handle-display";

/**
 * What automatic following is doing, on the page where the work starts.
 *
 * Before this, /relationships said "Nothing here runs on its own" while
 * a campaign could be following people all day — the only way to see it
 * was a nav entry that lived inside the More sheet on mobile. An
 * operator could not tell, from the page they were on, whether Signal
 * was acting for them.
 *
 * Reads nothing but a summary. The queue behind it may hold 100,000
 * members; none of them are loaded to draw this.
 */

const STATUS_COPY: Record<
  string,
  { label: string; tone: "running" | "attention" | "stopped" | "done" }
> = {
  active: { label: "Following automatically", tone: "running" },
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

export function AutomationPanel({ summary }: { summary: CampaignSummary }) {
  const copy = STATUS_COPY[summary.status] ?? {
    label: summary.status,
    tone: "stopped" as const,
  };
  const identity = formatIdentityLabel({
    id: summary.id,
    handle: summary.identityHandle,
    displayName: summary.identityDisplayName,
  });
  const percent =
    summary.total > 0
      ? Math.min(100, Math.round((summary.completed / summary.total) * 100))
      : 0;
  const finished = summary.status === "completed";

  return (
    <section
      className="card card-padded"
      aria-label="Automatic following status"
      data-testid="automation-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title truncate">{summary.name}</h2>
          <p className="text-sm text-ink-500 mt-0.5 break-words">
            Acting as {identity}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
            TONE_CLASS[copy.tone]
          }`}
        >
          {copy.label}
        </span>
      </div>

      {summary.dryRun ? (
        <p className="mt-3 text-sm text-ink-600">
          Test mode: Signal is not sending any follows.
        </p>
      ) : null}

      {finished ? (
        // The most important sentence on the panel once it is over. An
        // operator must not have to infer that nothing more will happen.
        <p className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          All {summary.total.toLocaleString()} profiles have been processed.
          Signal will not follow anyone else for this campaign.
        </p>
      ) : null}

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-ink-600">
            {summary.completed.toLocaleString()} of{" "}
            {summary.total.toLocaleString()} profiles done
          </span>
          <span className="text-ink-500 tabular-nums">{percent}%</span>
        </div>
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink-100"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Campaign progress"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="stat-label">Tried today</dt>
          <dd className="text-sm text-ink-900 tabular-nums">
            {summary.attemptedToday.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="stat-label">Followed today</dt>
          <dd className="text-sm text-ink-900 tabular-nums">
            {summary.succeededToday.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="stat-label">You asked for</dt>
          <dd className="text-sm text-ink-900 tabular-nums">
            {summary.requestedDailyQuota.toLocaleString()}/day
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt className="stat-label">Today&apos;s limit</dt>
          <dd className="text-sm text-ink-900">
            <span className="tabular-nums">
              {summary.effectiveDailyQuota.toLocaleString()}
            </span>
            {summary.effectiveQuotaReason ? (
              // Requested and actual are shown separately on purpose:
              // the number asked for is not a promise, and the reason it
              // differs is the operator's business.
              <span className="text-ink-500"> — {summary.effectiveQuotaReason}</span>
            ) : null}
          </dd>
        </div>
      </dl>

      {!finished ? (
        <p className="mt-3 text-sm text-ink-500">{formatNextRun(summary.nextRunAt)}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/relationships/campaigns?campaign=${summary.id}`}
          className="btn-secondary min-h-11 inline-flex items-center"
        >
          View campaign
        </Link>
        {summary.status === "active" || summary.status === "rate_limited" ? (
          // Pause only. Stopping for good is a different, destructive
          // decision and lives on the campaign page with its own
          // confirmation — it must not sit here looking like this one.
          <Link
            href={`/relationships/campaigns?campaign=${summary.id}#pause`}
            className="btn-secondary min-h-11 inline-flex items-center"
          >
            Pause
          </Link>
        ) : null}
      </div>
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
 * The follow flow had to learn this the hard way: it lived behind a nav
 * entry inside the mobile More sheet, and an operator working on a
 * phone had no way to discover it existed.
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
