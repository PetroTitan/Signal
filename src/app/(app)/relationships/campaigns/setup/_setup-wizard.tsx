"use client";
/**
 * Setting up automatic following.
 *
 * One screen, three steps, plain language. Before this the operator had
 * to create a draft on one page, open it, run an import, notice it had
 * not finished, run it again, and then find the activate control — four
 * surfaces for what is one decision.
 *
 * The steps are still real underneath. Step 2 creates a DRAFT and
 * begins building the queue; step 3 is the only thing that starts
 * public activity, and it needs an explicit confirmation. Leaving at
 * any point before that sends nothing to Bluesky.
 */

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import {
  activateFromSetupAction,
  continueImportAction,
  previewSourceAction,
  startCampaignSetupAction,
  type ActivateSetupResult,
  type ContinueImportResult,
  type SourcePreviewResult,
  type StartSetupResult,
} from "./_actions";
import { DAILY_QUOTA_OPTIONS } from "@/core/bluesky-campaigns/quota";
import { COMMON_TIMEZONES } from "@/core/bluesky-campaigns/campaign-day";
import { formatIdentityLabel } from "@/core/bluesky-relationships/handle-display";

export interface SetupIdentity {
  id: string;
  handle: string | null;
  displayName: string | null;
}
export interface SetupTarget {
  id: string;
  handle: string | null;
  displayName: string | null;
  candidateCount: number;
}

const EMPTY_PREVIEW: SourcePreviewResult = { ok: false, error: "" };
const EMPTY_START: StartSetupResult = { ok: false, error: "" };
const EMPTY_CONTINUE: ContinueImportResult = { ok: false, error: "" };
const EMPTY_ACTIVATE: ActivateSetupResult = { ok: false, error: "" };

function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-primary min-h-11 w-full sm:w-auto"
      disabled={pending}
    >
      {pending ? busy : label}
    </button>
  );
}

function StepHeading({ n, of, title }: { n: number; of: number; title: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="stat-label shrink-0">
        Step {n} of {of}
      </span>
      <h2 className="section-title truncate">{title}</h2>
    </div>
  );
}

export function SetupWizard(props: {
  identities: SetupIdentity[];
  targets: SetupTarget[];
  defaultTimezone: string;
  candidateTotal: number;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [identityId, setIdentityId] = useState(props.identities[0]?.id ?? "");
  const [sourceKind, setSourceKind] = useState<"candidates" | "target_followers">(
    "candidates",
  );
  const [targetId, setTargetId] = useState("");
  const [quota, setQuota] = useState(300);
  const [timezone, setTimezone] = useState(props.defaultTimezone);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("20:00");
  const [startDate, setStartDate] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [name, setName] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const [preview, previewAction] = useFormState(previewSourceAction, EMPTY_PREVIEW);
  const [started, startAction] = useFormState(startCampaignSetupAction, EMPTY_START);
  const [continued, continueAction] = useFormState(
    continueImportAction,
    EMPTY_CONTINUE,
  );
  const [activated, activateAction] = useFormState(
    activateFromSetupAction,
    EMPTY_ACTIVATE,
  );

  useEffect(() => {
    if (started.ok) {
      setCampaignId(started.campaignId);
      setStep(3);
      // The campaign id is durable state. Put it in the URL immediately
      // so reload/back/return can recover through the campaign page.
      window.history.replaceState(
        null,
        "",
        `/relationships/campaigns/setup?campaign=${encodeURIComponent(started.campaignId)}`,
      );
    }
  }, [started]);

  const identity = props.identities.find((i) => i.id === identityId);
  const identityLabel = identity ? formatIdentityLabel(identity) : "—";
  const target = props.targets.find((t) => t.id === targetId);

  const eligible = preview.ok ? preview.eligible : null;
  const protectedExcluded = preview.ok ? preview.protectedExcluded : 0;

  // Progress reported by whichever call spoke last.
  const progress = continued.ok
    ? {
        imported: continued.imported,
        duplicates: continued.duplicates,
        excluded: continued.excluded,
        complete: continued.complete,
        status: continued.status,
      }
    : started.ok
      ? {
          imported: started.imported,
          duplicates: started.duplicates,
          excluded: started.excluded,
          complete: started.complete,
          status: started.status,
        }
      : null;

  const sourceLabel =
    sourceKind === "target_followers"
      ? `followers of ${target ? formatIdentityLabel(target) : "—"}`
      : targetId
        ? `your imported list from ${target ? formatIdentityLabel(target) : "—"}`
        : "everyone you have imported";

  const queueSize = progress?.imported ?? eligible ?? 0;
  const ready = progress?.complete === true;

  const days = useMemo(
    () => (queueSize > 0 ? Math.ceil(queueSize / quota) : 0),
    [queueSize, quota],
  );

  return (
    <div className="space-y-6">
      {/* ── Step 1 ─────────────────────────────────────────────── */}
      <section className="card card-padded" aria-current={step === 1 || undefined}>
        <StepHeading n={1} of={3} title="Choose who to follow" />
        {step === 1 ? (
          <form action={previewAction} className="mt-4 space-y-4">
            <div>
              <label htmlFor="identity" className="stat-label">
                Which account does the following
              </label>
              <select
                id="identity"
                name="operator_account_id"
                className="input w-full mt-1 min-h-11"
                value={identityId}
                onChange={(e) => setIdentityId(e.target.value)}
              >
                {props.identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {formatIdentityLabel(i)}
                  </option>
                ))}
              </select>
            </div>

            {/* A bare <fieldset> carries a browser default of
                `min-inline-size: min-content` plus its own padding, and
                refuses to shrink below its widest child — which pushed
                this page 8px past the viewport at 320px with no single
                element being too wide. Measured in Chromium, not
                guessed. */}
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="stat-label">Which profiles</legend>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-3 rounded-md border border-ink-200 p-3 min-h-11">
                  <input
                    type="radio"
                    name="source_choice"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={sourceKind === "candidates" && !targetId}
                    onChange={() => {
                      setSourceKind("candidates");
                      setTargetId("");
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-ink-900">
                      Everyone I have imported
                    </span>
                    <span className="block text-sm text-ink-500">
                      {props.candidateTotal.toLocaleString()} profile(s) collected
                      so far
                    </span>
                  </span>
                </label>

                {props.targets.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-start gap-3 rounded-md border border-ink-200 p-3 min-h-11"
                  >
                    <input
                      type="radio"
                      name="source_choice"
                      className="mt-1 h-5 w-5 shrink-0"
                      checked={targetId === t.id}
                      onChange={() => {
                        setSourceKind("candidates");
                        setTargetId(t.id);
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink-900 break-words">
                        People I imported from {formatIdentityLabel(t)}
                      </span>
                      <span className="block text-sm text-ink-500">
                        {t.candidateCount.toLocaleString()} profile(s) from this
                        list
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {/* One list, never a blend of two. */}
              <p className="mt-2 text-sm text-ink-500">
                Signal uses only the list you pick here.
              </p>
            </fieldset>

            <input type="hidden" name="target_profile_id" value={targetId} />

            <div className="flex flex-wrap items-center gap-3">
              <Submit label="Check this list" busy="Checking…" />
              {preview.ok ? (
                <button
                  type="button"
                  className="btn-secondary min-h-11"
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              ) : null}
            </div>

            {!preview.ok && preview.error ? (
              <p className="text-sm text-rose-700">{preview.error}</p>
            ) : null}

            {preview.ok ? (
              <dl
                className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-ink-50 p-3"
                data-testid="source-preview"
              >
                <dt className="stat-label">Will be followed</dt>
                <dd className="text-sm text-ink-900 tabular-nums">
                  {eligible?.toLocaleString()}
                </dd>
                <dt className="stat-label">Skipped — private accounts</dt>
                <dd className="text-sm text-ink-900 tabular-nums">
                  {protectedExcluded.toLocaleString()}
                </dd>
                <dt className="stat-label">Following as</dt>
                <dd className="text-sm text-ink-900 break-words">{identityLabel}</dd>
              </dl>
            ) : null}
          </form>
        ) : (
          <p className="mt-2 text-sm text-ink-600 break-words">
            {eligible?.toLocaleString() ?? "—"} profiles from {sourceLabel}, as{" "}
            {identityLabel}.{" "}
            <button
              type="button"
              className="link"
              onClick={() => setStep(1)}
              disabled={campaignId !== null}
            >
              Change
            </button>
          </p>
        )}
      </section>

      {/* ── Step 2 ─────────────────────────────────────────────── */}
      <section className="card card-padded" aria-current={step === 2 || undefined}>
        <StepHeading n={2} of={3} title="Choose how fast" />
        {step === 2 ? (
          <form action={startAction} className="mt-4 space-y-4">
            <div>
              <label htmlFor="quota" className="stat-label">
                Profiles to follow each day
              </label>
              <select
                id="quota"
                name="requested_daily_quota"
                className="input w-full mt-1 min-h-11"
                value={quota}
                onChange={(e) => setQuota(Number(e.target.value))}
              >
                {DAILY_QUOTA_OPTIONS.map((q) => (
                  <option key={q} value={q}>
                    {q.toLocaleString()} a day
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-ink-500">
                Signal may do fewer on a given day — Bluesky&apos;s own limits and
                your account&apos;s recent activity come first.
              </p>
            </div>

            <div>
              <label htmlFor="name" className="stat-label">
                Name this campaign
              </label>
              <input
                id="name"
                name="name"
                className="input w-full mt-1 min-h-11"
                placeholder="Designers who follow @someone"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="timezone" className="stat-label">
                  Time zone
                </label>
                <select
                  id="timezone"
                  name="timezone"
                  className="input w-full mt-1 min-h-11"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {/* The browser's own zone first when it is not one of
                      the offered ones, so a default detected from the
                      operator's machine is never silently discarded. */}
                  {((COMMON_TIMEZONES as readonly string[]).includes(timezone)
                    ? (COMMON_TIMEZONES as readonly string[])
                    : [timezone, ...(COMMON_TIMEZONES as readonly string[])]
                  ).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="start_date" className="stat-label">
                  Start on (optional)
                </label>
                <input
                  id="start_date"
                  name="start_date"
                  type="date"
                  className="input w-full mt-1 min-h-11"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="window_start" className="stat-label">
                  Each day, from
                </label>
                <input
                  id="window_start"
                  name="window_start"
                  type="time"
                  className="input w-full mt-1 min-h-11"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="window_end" className="stat-label">
                  Until
                </label>
                <input
                  id="window_end"
                  name="window_end"
                  type="time"
                  className="input w-full mt-1 min-h-11"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                />
              </div>
            </div>

            <label className="flex items-start gap-3 min-h-11">
              <input
                type="checkbox"
                name="dry_run"
                value="1"
                className="mt-1 h-5 w-5 shrink-0"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="text-sm text-ink-700">
                Test mode — go through the motions without following anyone.
              </span>
            </label>

            <input type="hidden" name="operator_account_id" value={identityId} />
            <input type="hidden" name="source_kind" value={sourceKind} />
            <input type="hidden" name="target_profile_id" value={targetId} />

            <div className="flex flex-wrap items-center gap-3">
              <Submit label="Build the list" busy="Building…" />
              <button
                type="button"
                className="btn-secondary min-h-11"
                onClick={() => setStep(1)}
              >
                Back
              </button>
            </div>
            <p className="text-sm text-ink-500">
              This prepares the campaign. Nobody is followed until you confirm on
              the next step.
            </p>
            {!started.ok && started.error ? (
              <p className="text-sm text-rose-700">{started.error}</p>
            ) : null}
          </form>
        ) : step === 3 ? (
          <p className="mt-2 text-sm text-ink-600">
            {quota.toLocaleString()} a day, {windowStart}–{windowEnd} {timezone}.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-500">
            Choose a list first.
          </p>
        )}
      </section>

      {/* ── Step 3 ─────────────────────────────────────────────── */}
      <section className="card card-padded" aria-current={step === 3 || undefined}>
        <StepHeading n={3} of={3} title="Check and start" />
        {step !== 3 || !campaignId ? (
          <p className="mt-2 text-sm text-ink-500">
            You will see a summary here before anything starts.
          </p>
        ) : activated.ok ? (
          <div className="mt-3 space-y-3">
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {activated.summary}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/relationships" className="btn-primary min-h-11 inline-flex items-center">
                Back to relationships
              </Link>
              <Link
                href={`/relationships/campaigns?campaign=${campaignId}`}
                className="btn-secondary min-h-11 inline-flex items-center"
              >
                View campaign
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            {/* Build status, in the operator's terms. */}
            <div
              className="rounded-md border border-ink-200 p-3"
              data-testid="import-status"
            >
              <p className="text-sm text-ink-900">
                {ready
                  ? `Ready — ${queueSize.toLocaleString()} profiles queued.`
                  : progress?.status === "failed"
                    ? "The list could not be finished."
                    : `Building the list — ${queueSize.toLocaleString()} queued so far.`}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="stat-label">Already queued</dt>
                <dd className="text-sm text-ink-700 tabular-nums">
                  {(progress?.duplicates ?? 0).toLocaleString()}
                </dd>
                <dt className="stat-label">Skipped — private</dt>
                <dd className="text-sm text-ink-700 tabular-nums">
                  {(progress?.excluded ?? 0).toLocaleString()}
                </dd>
              </dl>
              {!ready ? (
                <form action={continueAction} className="mt-3">
                  <input type="hidden" name="campaign_id" value={campaignId} />
                  <Submit label="Keep building" busy="Building…" />
                  <p className="mt-2 text-sm text-ink-500">
                    Long lists take a few rounds. You can leave this page and come
                    back — progress is saved.
                  </p>
                </form>
              ) : null}
              {!continued.ok && continued.error ? (
                <p className="mt-2 text-sm text-rose-700">{continued.error}</p>
              ) : null}
            </div>

            <p className="text-sm text-ink-900 leading-relaxed">
              Follow up to <strong>{quota.toLocaleString()}</strong> profiles per
              day from <strong>{sourceLabel}</strong> as{" "}
              <strong>{identityLabel}</strong> during{" "}
              <strong>
                {windowStart}–{windowEnd} {timezone}
              </strong>{" "}
              until all <strong>{queueSize.toLocaleString()}</strong> profiles have
              been processed
              {days > 0 ? ` — about ${days.toLocaleString()} day(s)` : ""}.
            </p>

            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Follows are public, and Bluesky may notify the people you follow.
              You can pause this at any time.
            </p>

            <form action={activateAction} className="space-y-3">
              <input type="hidden" name="campaign_id" value={campaignId} />
              <input type="hidden" name="confirm" value="start" />
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className="btn-primary min-h-11 w-full sm:w-auto"
                  disabled={!ready}
                >
                  Start following
                </button>
                {/* Leaving sends nothing. */}
                <Link
                  href="/relationships"
                  className="btn-secondary min-h-11 inline-flex items-center"
                >
                  Cancel
                </Link>
              </div>
              {!ready ? (
                <p className="text-sm text-ink-500">
                  You can start once the list says ready.
                </p>
              ) : null}
              {!activated.ok && activated.error ? (
                <p className="text-sm text-rose-700">{activated.error}</p>
              ) : null}
            </form>
          </div>
        )}
      </section>
    </div>
  );
}

export { minutesToHhmm };
