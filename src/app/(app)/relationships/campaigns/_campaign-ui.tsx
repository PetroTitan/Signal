"use client";
/**
 * Bluesky follow campaigns — operator surface.
 *
 * Mobile-first, and for a 100,000-member campaign it renders: a status
 * card, a counts grid, one page of at most 50 members, and one page of
 * runs. It never downloads or renders the queue.
 *
 * Every number shown is an exact database count. The two quota figures
 * are ALWAYS shown together and never collapsed into one — "1000/day"
 * on its own would be a promise Signal cannot keep, and the whole point
 * of the effective quota is to say so when it is lower and why.
 */

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  activateCampaignAction,
  cancelCampaignAction,
  changeQuotaAction,
  importCampaignMembersAction,
  reconcileCampaignNowAction,
  pauseCampaignAction,
  setKillSwitchAction,
  type CampaignLifecycleResult,
  type ImportCampaignResult,
  type KillSwitchResult,
  type QuotaChangeResult,
} from "./_actions";
import { DAILY_QUOTA_OPTIONS } from "@/core/bluesky-campaigns/quota";
import { isResumableCampaignStatus } from "@/core/bluesky-campaigns/campaign-recovery";
import { formatMinutes } from "@/core/bluesky-campaigns/campaign-day";
import { formatHandle } from "@/core/bluesky-relationships/handle-display";
import type {
  BlueskyCampaignKillSwitchRow,
  BlueskyFollowCampaignRow,
} from "@/lib/supabase/types";
import type {
  CampaignDetail,
  CampaignKindFilter,
} from "@/core/bluesky-campaigns/load-campaigns.server";

const EMPTY_LIFECYCLE: CampaignLifecycleResult = { ok: false, error: "" };
const EMPTY_IMPORT: ImportCampaignResult = { ok: false, error: "" };
const EMPTY_QUOTA: QuotaChangeResult = { ok: false, error: "" };
const EMPTY_KILL: KillSwitchResult = { ok: false, error: "" };

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  active: "badge-low",
  paused: "badge-medium",
  completed: "badge-low",
  reauthorization_required: "badge-high",
  rate_limited: "badge-medium",
  failed: "badge-high",
  cancelled: "badge-neutral",
};

function SubmitButton({
  children,
  className = "btn-secondary",
  disabled,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? "Working…" : children}
    </button>
  );
}

function Notice({
  result,
}: {
  result: { ok: boolean; error: string | null } & Record<string, unknown>;
}) {
  if (result.ok && typeof result.summary === "string") {
    return (
      <p className="text-sm text-emerald-700 mt-2 leading-relaxed">
        {result.summary}
      </p>
    );
  }
  if (!result.ok && result.error) {
    return <p className="text-sm text-red-700 mt-2 leading-relaxed">{result.error}</p>;
  }
  return null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="stat-label">{label}</p>
      <p className="text-xl font-semibold text-ink-900 break-words">{value}</p>
      {hint ? (
        <p className="text-xs text-ink-500 mt-0.5 leading-relaxed break-words">{hint}</p>
      ) : null}
    </div>
  );
}

export function CampaignUi(props: {
  identities: { id: string; handle: string | null; displayName: string | null }[];
  campaigns: BlueskyFollowCampaignRow[];
  kindFilter?: CampaignKindFilter;
  detail: CampaignDetail | null;
  killSwitches: BlueskyCampaignKillSwitchRow[];
}) {
  const kindFilter = props.kindFilter ?? "all";
  const [activateState, runActivate] = useFormState(
    activateCampaignAction,
    EMPTY_LIFECYCLE,
  );
  const [pauseState, runPause] = useFormState(pauseCampaignAction, EMPTY_LIFECYCLE);
  const [cancelState, runCancel] = useFormState(
    cancelCampaignAction,
    EMPTY_LIFECYCLE,
  );
  const [importState, runImport] = useFormState(
    importCampaignMembersAction,
    EMPTY_IMPORT,
  );
  const [quotaState, runQuota] = useFormState(changeQuotaAction, EMPTY_QUOTA);
  const [killState, runKill] = useFormState(setKillSwitchAction, EMPTY_KILL);

  const globalSwitch = props.killSwitches.find(
    (k) => k.operator_account_id === null && k.engaged,
  );

  if (props.identities.length === 0) {
    return (
      <div className="card card-padded">
        <h2 className="section-title">No Bluesky identity</h2>
        <p className="text-sm text-ink-600 mt-2 leading-relaxed">
          A campaign follows accounts as one of your Bluesky publishing
          identities. Add one on Accounts and sign it in first.
        </p>
        <Link href="/accounts" className="btn-nav mt-4 inline-flex">
          Go to Accounts
        </Link>
      </div>
    );
  }

  const d = props.detail;

  return (
    <div className="space-y-4">
      {globalSwitch ? (
        <div className="card card-padded border-red-200 bg-red-50" role="alert">
          <p className="text-sm text-red-900 leading-relaxed">
            <strong>Campaigns are stopped for this workspace.</strong>{" "}
            {globalSwitch.reason ?? "The kill switch is engaged."} Nothing will
            run until it is released.
          </p>
          <form action={runKill} className="mt-3">
            <input type="hidden" name="scope" value="workspace" />
            <input type="hidden" name="engaged" value="0" />
            <SubmitButton>Release the kill switch</SubmitButton>
          </form>
          <Notice result={killState} />
        </div>
      ) : null}

      {/* Kind filter. Follow and unfollow campaigns share this list;
          each entry says which it is, and an unfollow entry opens its
          own screen. */}
      <nav aria-label="Campaign kind" className="flex flex-wrap gap-2" data-testid="kind-filter">
        {(
          [
            ["all", "All campaigns"],
            ["follow", "Follow"],
            ["unfollow", "Unfollow"],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            href={value === "all" ? "/relationships/campaigns" : `/relationships/campaigns?kind=${value}`}
            aria-current={kindFilter === value ? "page" : undefined}
            className={`btn min-h-11 inline-flex items-center ${
              kindFilter === value ? "nav-item-active border-signal-300" : ""
            }`}
          >
            {label}
          </Link>
        ))}
        <Link href="/relationships/unfollow" className="btn-secondary min-h-11 inline-flex items-center">
          Unfollow people…
        </Link>
      </nav>

      {/* Campaign picker */}
      {props.campaigns.length > 0 ? (
        <nav
          aria-label="Campaigns"
          className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto"
        >
          <ul className="flex gap-2 list-none p-0 m-0 w-max min-w-full">
            {props.campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  href={
                    c.kind === "unfollow"
                      ? `/relationships/unfollow/${c.id}`
                      : `/relationships/campaigns?campaign=${c.id}`
                  }
                  aria-current={d?.campaign.id === c.id ? "page" : undefined}
                  className={`btn min-h-11 inline-flex items-center whitespace-nowrap ${
                    d?.campaign.id === c.id ? "nav-item-active border-signal-300" : ""
                  }`}
                  data-kind={c.kind}
                >
                  <span className={`mr-1.5 ${c.kind === "unfollow" ? "badge-neutral" : "badge-info"}`}>
                    {c.kind === "unfollow" ? "Unfollow" : "Follow"}
                  </span>
                  {c.name}
                  <span className={`ml-1.5 ${STATUS_BADGE[c.status] ?? "badge-neutral"}`}>
                    {c.status.replace(/_/g, " ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {d ? (
        <CampaignDetailView
          detail={d}
          identities={props.identities}
          runActivate={runActivate}
          activateState={activateState}
          runPause={runPause}
          pauseState={pauseState}
          runCancel={runCancel}
          cancelState={cancelState}
          runImport={runImport}
          importState={importState}
          runQuota={runQuota}
          quotaState={quotaState}
          runKill={runKill}
          killState={killState}
        />
      ) : (
        <div className="card card-padded" data-testid="campaigns-empty">
          <p className="text-sm text-ink-600 leading-relaxed">
            {kindFilter === "unfollow"
              ? "No unfollow campaigns yet. Use “Unfollow people…” to choose who to stop following, how many a day, and confirm once."
              : kindFilter === "follow"
                ? "No follow campaigns yet. Create one below to queue profiles and follow them on a daily schedule."
                : "No campaigns yet. Create a follow campaign below, or use “Unfollow people…” to set up automatic unfollowing. Each campaign is labelled with what it does."}
          </p>
        </div>
      )}
    </div>
  );
}

function CampaignDetailView(props: {
  detail: CampaignDetail;
  identities: { id: string; handle: string | null; displayName: string | null }[];
  runActivate: (fd: FormData) => void;
  activateState: CampaignLifecycleResult;
  runPause: (fd: FormData) => void;
  pauseState: CampaignLifecycleResult;
  runCancel: (fd: FormData) => void;
  cancelState: CampaignLifecycleResult;
  runImport: (fd: FormData) => void;
  importState: ImportCampaignResult;
  runQuota: (fd: FormData) => void;
  quotaState: QuotaChangeResult;
  runKill: (fd: FormData) => void;
  killState: KillSwitchResult;
}) {
  const { detail: d } = props;
  const c = d.campaign;
  const today = d.today;
  const identity = props.identities.find((i) => i.id === c.operator_account_id);
  const [reconcileState, runReconcile] = useFormState(
    reconcileCampaignNowAction,
    EMPTY_LIFECYCLE,
  );

  return (
    <div className="space-y-4">
      {/* Status + next action */}
      <section className="card card-padded">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink-900 break-words min-w-0">
            {c.name}
          </h2>
          <span className={STATUS_BADGE[c.status] ?? "badge-neutral"}>
            {c.status.replace(/_/g, " ")}
          </span>
          {c.dry_run ? <span className="badge-info">Dry run</span> : null}
        </div>

        <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
          Acting as{" "}
          <span className="font-medium text-ink-900 break-all">
            {formatHandle(identity?.handle, c.operator_account_id)}
          </span>{" "}
          · {c.timezone} · {formatMinutes(c.execution_window_start_minute)}–
          {formatMinutes(c.execution_window_end_minute)} local
        </p>

        <p className="text-sm text-ink-600 mt-1 leading-relaxed">
          Local date {d.localDate} ·{" "}
          {d.insideWindow
            ? "inside today's execution window"
            : `next window ${d.nextWindowAt ?? "unscheduled"}`}
        </p>

        {d.nextUserAction ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 mt-3 leading-relaxed">
            {d.nextUserAction}
          </p>
        ) : null}

        {c.last_error_message ? (
          <p className="text-xs text-red-700 mt-2 leading-relaxed break-words">
            {c.last_error_message}
          </p>
        ) : null}
      </section>

      {/* Quotas — requested and effective, never collapsed */}
      <section className="card card-padded">
        <h3 className="section-title">Daily quota</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
          <Stat label="Requested" value={String(c.requested_daily_quota)} />
          <Stat
            label="Effective now"
            value={String(d.effectiveQuota.effective)}
            hint={d.effectiveQuota.effective < c.requested_daily_quota ? "lower" : undefined}
          />
          <Stat
            label="Identity used today"
            value={`${d.identityFollowsToday} / ${d.identityCeiling}`}
            hint="shared by every campaign on this identity"
          />
          <Stat
            label="Remaining eligible"
            value={d.counts.remainingEligible.toLocaleString()}
          />
        </div>
        {d.effectiveQuota.reason ? (
          <p className="text-sm text-ink-700 mt-3 leading-relaxed">
            {d.effectiveQuota.reason}
          </p>
        ) : null}
        <p className="text-xs text-ink-500 mt-3 leading-relaxed">
          Signal never promises a number of follows. Bluesky&apos;s limits,
          account health and its moderation systems all apply, and the effective
          quota above is what Signal is willing to attempt right now.
        </p>

        <form action={props.runQuota} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="campaign_id" value={c.id} />
          <label htmlFor="quota" className="sr-only">
            Requested daily quota
          </label>
          <select
            id="quota"
            name="requested_daily_quota"
            defaultValue={String(c.requested_daily_quota)}
            className="input min-w-0"
          >
            {DAILY_QUOTA_OPTIONS.map((q) => (
              <option key={q} value={q}>
                {q} / day
              </option>
            ))}
          </select>
          <SubmitButton>Change for future runs</SubmitButton>
        </form>
        <Notice result={props.quotaState} />
      </section>

      {/* Today */}
      <section className="card card-padded">
        <h3 className="section-title">Today ({d.localDate})</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
          <Stat label="Attempted" value={String(today?.attempted_count ?? 0)} />
          <Stat
            label="Succeeded"
            value={String(today?.succeeded_count ?? 0)}
            hint="follow records created"
          />
          <Stat
            label="Skipped"
            value={String(
              (today?.skipped_count ?? 0) + (today?.already_following_count ?? 0),
            )}
            hint="no quota consumed"
          />
          <Stat label="Failed" value={String(today?.failed_count ?? 0)} />
        </div>
        {today?.rate_limited_until ? (
          <p className="text-sm text-amber-800 mt-3 leading-relaxed break-words">
            Rate-limited by Bluesky until {today.rate_limited_until}.
          </p>
        ) : null}
        {d.lastSuccessAt ? (
          <p className="text-xs text-ink-500 mt-2 break-words">
            Last successful action {d.lastSuccessAt}
          </p>
        ) : null}
      </section>

      {/* Overall progress */}
      <section className="card card-padded">
        <h3 className="section-title">Progress</h3>
        <p className="text-sm text-ink-800 bg-ink-50 border border-ink-200 rounded-md p-3 mt-3 leading-relaxed">
          Signal will continue processing all{" "}
          <strong>{d.counts.total.toLocaleString()}</strong> profiles
          automatically across future days until every profile has a confirmed
          outcome. The daily quota limits daily work, not the campaign size.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
          <Stat label="Queued total" value={d.counts.total.toLocaleString()} />
          <Stat label="Succeeded" value={d.counts.succeeded.toLocaleString()} />
          <Stat
            label="Remaining"
            value={d.counts.remainingEligible.toLocaleString()}
          />
          <Stat label="Complete" value={`${d.percentComplete}%`} />
        </div>
        <div
          className="mt-3 h-2 w-full rounded-full bg-ink-100 overflow-hidden"
          role="progressbar"
          aria-valuenow={d.percentComplete}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Campaign progress"
        >
          <div
            className="h-full bg-signal-600"
            style={{ width: `${d.percentComplete}%` }}
          />
        </div>
        <p className="text-sm text-ink-600 mt-3 leading-relaxed">
          {d.estimatedCompletion
            ? `At the rate observed so far, about ${d.estimatedCompletion.daysRemaining} more day(s) — around ${d.estimatedCompletion.date}.`
            : "No completion estimate yet: an estimate needs at least one finished run to measure against."}
        </p>
        {/* The three groups an operator actually asks about. They sum
            to the frozen total, which never shrinks — a profile that
            fails, waits or changes handle stays in the denominator. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
          <div className="min-w-0">
            <h4 className="stat-label">Desired state achieved</h4>
            <p className="text-sm text-ink-800 mt-1 leading-relaxed">
              Followed {d.outcomes.achieved.succeeded.toLocaleString()} · already
              following {d.outcomes.achieved.alreadyFollowing.toLocaleString()}
            </p>
          </div>
          <div className="min-w-0">
            <h4 className="stat-label">Impossible, with reason</h4>
            <p className="text-sm text-ink-800 mt-1 leading-relaxed">
              Account not found {d.outcomes.impossible.actorNotFound.toLocaleString()} ·
              protected or not followable{" "}
              {d.outcomes.impossible.protected.toLocaleString()} · rejected by
              Bluesky {d.outcomes.impossible.failedStructural.toLocaleString()} ·
              cancelled {d.outcomes.impossible.cancelled.toLocaleString()}
              {Object.entries(d.outcomes.impossible.otherByReason).map(([k, v]) => (
                <span key={k}>
                  {" "}· {k.replace(/_/g, " ")} {v.toLocaleString()}
                </span>
              ))}
            </p>
          </div>
          <div className="min-w-0">
            <h4 className="stat-label">Still pending</h4>
            <p className="text-sm text-ink-800 mt-1 leading-relaxed">
              Waiting {d.outcomes.pending.queued.toLocaleString()} · in progress{" "}
              {d.outcomes.pending.leased.toLocaleString()} · retrying{" "}
              {d.outcomes.pending.retrying.toLocaleString()} · checking with
              Bluesky {d.outcomes.pending.reconciling.toLocaleString()}
            </p>
          </div>
        </div>
        {d.outcomes.impossible.actorNotFound +
          d.outcomes.impossible.failedStructural +
          d.outcomes.pending.reconciling >
        0 ? (
          <p className="text-xs text-ink-600 mt-3 leading-relaxed">
            Profiles that could not reach a final Follow state are listed in
            the queue below with the exact reason — filter by{" "}
            <a href={`?campaign=${c.id}&status=skipped`} className="underline">
              skipped
            </a>
            ,{" "}
            <a href={`?campaign=${c.id}&status=failed_structural`} className="underline">
              failed
            </a>{" "}
            or{" "}
            <a href={`?campaign=${c.id}&status=retryable`} className="underline">
              retrying
            </a>
            .
          </p>
        ) : null}
      </section>

      {/* Controls */}
      <section className="card card-padded">
        <h3 className="section-title">Controls</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {isResumableCampaignStatus(c.status) ? (
            <form action={props.runActivate}>
              <input type="hidden" name="campaign_id" value={c.id} />
              <SubmitButton className="btn-primary" disabled={d.counts.total === 0}>
                {c.status === "draft" ? "Activate campaign" : "Resume"}
              </SubmitButton>
            </form>
          ) : null}

          {c.status === "active" ||
          c.status === "rate_limited" ||
          c.status === "reauthorization_required" ? (
            <form action={props.runPause}>
              <input type="hidden" name="campaign_id" value={c.id} />
              <SubmitButton>Pause now</SubmitButton>
            </form>
          ) : null}

          {c.status !== "completed" && c.status !== "cancelled" ? (
            <form action={props.runCancel}>
              <input type="hidden" name="campaign_id" value={c.id} />
              <SubmitButton className="btn-danger">Cancel future work</SubmitButton>
            </form>
          ) : null}

          <form action={props.runKill}>
            <input type="hidden" name="scope" value="identity" />
            <input
              type="hidden"
              name="operator_account_id"
              value={c.operator_account_id}
            />
            <input type="hidden" name="engaged" value="1" />
            <input
              type="hidden"
              name="reason"
              value="Stopped from the campaign screen."
            />
            <SubmitButton className="btn-danger">Stop this identity</SubmitButton>
          </form>
        </div>
        <Notice result={props.activateState} />
        <Notice result={props.pauseState} />
        <Notice result={props.cancelState} />
        <Notice result={props.killState} />

        {/* Reconcile now: READS Bluesky for every action whose outcome is
            unknown. Runs the dispatcher with zero reserved units, so no
            follow can be funded and none is sent. */}
        <div className="mt-3 border border-ink-200 rounded-md p-3 space-y-2" data-testid="reconcile-now">
          <p className="text-sm text-ink-800 leading-relaxed">
            <strong>{d.outcomes.pending.reconciling.toLocaleString()}</strong>{" "}
            {d.outcomes.pending.reconciling === 1 ? "action" : "actions"} awaiting confirmation
            from Bluesky. Reconciling reads the current relationship and settles what a read can
            settle. <strong>It never sends a follow or an unfollow.</strong>
          </p>
          <form action={runReconcile}>
            <input type="hidden" name="campaign_id" value={c.id} />
            <SubmitButton>Reconcile now</SubmitButton>
          </form>
          <Notice result={reconcileState} />
        </div>

        {c.status === "draft" ? (
          <p className="text-sm text-ink-700 mt-3 leading-relaxed border border-amber-200 bg-amber-50 rounded-md p-3">
            Activating starts an <strong>autonomous</strong> process. Follows are
            public, the accounts may be notified, and Signal will keep following
            on this schedule until the queue is done or you stop it. Nothing here
            unfollows anyone.
          </p>
        ) : null}
      </section>

      {/* Queue */}
      <section className="card card-padded">
        <h3 className="section-title">Queue</h3>
        <form action={props.runImport} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="campaign_id" value={c.id} />
          <input type="hidden" name="source" value="candidates" />
          <SubmitButton
            disabled={c.status === "completed" || c.status === "cancelled"}
          >
            Import from candidates
          </SubmitButton>
        </form>
        <Notice result={props.importState} />

        <p className="text-sm text-ink-600 mt-3 leading-relaxed">
          {d.memberPage.total.toLocaleString()} profile(s) in the queue. Showing{" "}
          {d.members.length} of them.
        </p>

        <ul className="list-none p-0 m-0 mt-3 space-y-2">
          {d.members.map((m) => (
            <li key={m.id} className="border-t border-ink-100 pt-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-sm text-ink-800 break-all min-w-0">
                  {formatHandle(m.current_handle, m.subject_did)}
                </span>
                <span
                  className={
                    m.status === "succeeded"
                      ? "badge-low"
                      : m.status === "failed_structural"
                        ? "badge-high"
                        : m.status === "retryable"
                          ? "badge-medium"
                          : "badge-neutral"
                  }
                >
                  {m.status.replace(/_/g, " ")}
                </span>
                <span className="text-xs text-ink-400">#{m.import_sequence}</span>
              </div>
              {m.last_error_message ? (
                <p className="text-xs text-ink-500 mt-1 leading-relaxed break-words">
                  {m.last_error_message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        <Pager
          info={d.memberPage}
          param="mpage"
          campaignId={c.id}
          label="Queue"
        />
      </section>

      {/* Daily runs */}
      <section className="card card-padded">
        <h3 className="section-title">Daily runs</h3>
        <ul className="list-none p-0 m-0 mt-3 space-y-2">
          {d.runs.map((r) => (
            <li key={r.id} className="border-t border-ink-100 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-900">
                  {r.local_date}
                </span>
                <span
                  className={
                    r.status === "completed"
                      ? "badge-low"
                      : r.status === "rate_limited" || r.status === "paused" || r.status === "waiting_for_auth"
                        ? "badge-medium"
                        : r.status === "failed"
                          ? "badge-high"
                          : "badge-info"
                  }
                >
                  {r.status === "waiting_for_auth" ||
                  (r.status === "paused" && r.last_error_code === "reauthorization_required")
                    ? "waiting for sign-in"
                    : r.status === "paused"
                      ? "paused by the system"
                      : r.status === "failed"
                        ? "stopped — needs review"
                        : r.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="text-sm text-ink-700 mt-1 leading-relaxed break-words">
                {r.succeeded_count} succeeded of {r.attempted_count} attempted ·
                quota {r.effective_daily_quota} of {r.requested_daily_quota}
                {r.failed_count > 0 ? ` · ${r.failed_count} failed` : ""}
              </p>
              {r.effective_quota_reason ? (
                <p className="text-xs text-ink-500 mt-1 leading-relaxed break-words">
                  {r.effective_quota_reason}
                </p>
              ) : null}
            </li>
          ))}
          {d.runs.length === 0 ? (
            <li className="text-sm text-ink-600">No runs yet.</li>
          ) : null}
        </ul>
        <Pager info={d.runPage} param="rpage" campaignId={c.id} label="Runs" />
      </section>
    </div>
  );
}

function Pager(props: {
  info: { page: number; pageSize: number; total: number; totalPages: number };
  param: "mpage" | "rpage";
  campaignId: string;
  label: string;
}) {
  const { page, pageSize, total, totalPages } = props.info;
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const href = (p: number) =>
    `/relationships/campaigns?campaign=${props.campaignId}&${props.param}=${p}`;

  return (
    <nav
      aria-label={`${props.label} pagination`}
      className="flex flex-wrap items-center gap-2 justify-between mt-3"
    >
      <p className="text-sm text-ink-600">
        {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        <span className="font-medium text-ink-900">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className="btn-secondary">
            Previous
          </Link>
        ) : (
          <span className="btn-secondary opacity-40" aria-disabled="true">
            Previous
          </span>
        )}
        <span className="text-sm text-ink-600 whitespace-nowrap">
          {page} / {totalPages}
        </span>
        {page < totalPages ? (
          <Link href={href(page + 1)} className="btn-secondary">
            Next
          </Link>
        ) : (
          <span className="btn-secondary opacity-40" aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
