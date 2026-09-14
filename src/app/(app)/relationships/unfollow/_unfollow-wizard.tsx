"use client";
/**
 * Setting up automatic unfollowing.
 *
 * One screen, three steps, plain language — the same shape as the
 * follow flow, because an operator who has used one should not have to
 * learn a second idiom for a more consequential action.
 *
 * The steps are real underneath. Step 2 creates a DRAFT and begins
 * building the queue; step 3 is the only thing that starts public
 * activity, and it needs an explicit typed confirmation of both the
 * acting identity and the action itself. Leaving at any point before
 * that sends nothing to Bluesky — not a single request.
 *
 * NO PAGE-SIZE CHOICE ANYWHERE. A large set is added SERVER-SIDE by a
 * durable, restartable job; the operator's only role is to say "keep
 * going" (or leave the page, which is also fine). Nothing here holds a
 * list of profiles in browser memory, at any size.
 */

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import {
  activateUnfollowCampaignAction,
  continueUnfollowImportAction,
  previewUnfollowSourceAction,
  startUnfollowSetupAction,
  type ActivateUnfollowResult,
  type ContinueUnfollowImportResult,
  type SourcePreviewResult,
  type StartUnfollowSetupResult,
} from "./_actions";
import {
  ConfirmActivationDialog,
  type ActivationFacts,
} from "./_confirm-activation";
import {
  UNFOLLOW_DAILY_QUOTA_OPTIONS,
  estimateDays,
  IDENTITY_DAILY_MUTATION_CEILING,
} from "@/core/bluesky-unfollow/quota";
import { COMMON_TIMEZONES } from "@/core/bluesky-campaigns/campaign-day";
import { formatIdentityLabel } from "@/core/bluesky-relationships/handle-display";

export interface WizardIdentity {
  id: string;
  handle: string | null;
  displayName: string | null;
}
export interface WizardTarget {
  id: string;
  handle: string | null;
  displayName: string | null;
  candidateCount: number;
}
export interface WizardFollowCampaign {
  id: string;
  name: string;
  succeeded: number;
}

const EMPTY_PREVIEW: SourcePreviewResult = { ok: false, error: "" };
const EMPTY_START: StartUnfollowSetupResult = { ok: false, error: "" };
const EMPTY_CONTINUE: ContinueUnfollowImportResult = { ok: false, error: "" };
const EMPTY_ACTIVATE: ActivateUnfollowResult = { ok: false, error: "" };

type SourceKind =
  | "following_records"
  | "target_followers"
  | "follow_campaign"
  | "filtered_candidates";

/**
 * The scopes, as an operator would describe them.
 *
 * Exactly one may be chosen. There is no "and also" — a campaign built
 * from two lists is one an operator cannot reason about, and the
 * database refuses it independently of this control.
 */
const SOURCES: { value: SourceKind; label: string; hint: string }[] = [
  {
    value: "following_records",
    label: "Everyone this account currently follows",
    hint: "Read directly from your account on Bluesky, so it is complete and current.",
  },
  {
    value: "target_followers",
    label: "Everyone from one imported list",
    hint: "Only the profiles from that list you currently follow.",
  },
  {
    value: "follow_campaign",
    label: "Profiles a Signal follow campaign followed",
    hint: "Only the ones that campaign actually followed — not ones it found you already followed.",
  },
  {
    value: "filtered_candidates",
    label: "Your current filtered list",
    hint: "Everyone in your relationships list you currently follow.",
  },
];

function minutesToHhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
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

export function UnfollowWizard(props: {
  identities: WizardIdentity[];
  targets: WizardTarget[];
  followCampaigns: WizardFollowCampaign[];
  defaultTimezone: string;
  canManage: boolean;
}) {
  const [identityId, setIdentityId] = useState(props.identities[0]?.id ?? "");
  const [sourceKind, setSourceKind] = useState<SourceKind>("following_records");
  const [targetProfileId, setTargetProfileId] = useState(
    props.targets[0]?.id ?? "",
  );
  const [sourceCampaignId, setSourceCampaignId] = useState(
    props.followCampaigns[0]?.id ?? "",
  );
  const [quota, setQuota] = useState<number>(100);
  const [timezone, setTimezone] = useState(props.defaultTimezone);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("20:00");
  const [dryRun, setDryRun] = useState(true);

  const [preview, previewDispatch] = useFormState(
    previewUnfollowSourceAction,
    EMPTY_PREVIEW,
  );
  const [start, startDispatch] = useFormState(
    startUnfollowSetupAction,
    EMPTY_START,
  );
  const [cont, contDispatch] = useFormState(
    continueUnfollowImportAction,
    EMPTY_CONTINUE,
  );
  const [activate, activateDispatch] = useFormState(
    activateUnfollowCampaignAction,
    EMPTY_ACTIVATE,
  );

  /**
   * Whether the confirmation is OPEN.
   *
   * Null means closed, and while it is null the dialog renders no form
   * at all — so there is nothing that could dispatch. Every
   * cancellation path sets it back to null.
   */
  const [confirming, setConfirming] = useState<ActivationFacts | null>(null);

  const campaignId = start.ok ? start.campaignId : null;
  const building = start.ok && !start.complete;
  const latest = cont.ok ? cont : start.ok ? start : null;
  const ready = Boolean(latest && latest.complete);

  const identity = props.identities.find((i) => i.id === identityId);
  const identityLabel = identity
    ? formatIdentityLabel({
        id: identity.id,
        handle: identity.handle,
        displayName: identity.displayName,
      })
    : "no account selected";

  const queued = latest?.imported ?? 0;
  const protectedExcluded = latest?.protectedExcluded ?? 0;
  const effective = Math.min(quota, IDENTITY_DAILY_MUTATION_CEILING);
  const days = estimateDays(queued, effective);

  // A finished activation closes the prompt and shows the result IN
  // PLACE of the form — so the same campaign cannot be started twice.
  const activationResult = useMemo(() => {
    if (activate.ok) return { ok: true, message: activate.summary };
    if (activate.error) return { ok: false, message: activate.error };
    return null;
  }, [activate]);

  // Unmounting is a cancellation. Nothing may survive it that could
  // still dispatch.
  useEffect(() => () => setConfirming(null), []);

  if (!props.canManage) {
    return (
      <div className="card card-padded">
        <p className="text-sm text-ink-700 leading-relaxed">
          Your role cannot set up automatic unfollowing. Ask an owner or admin.
        </p>
      </div>
    );
  }

  if (props.identities.length === 0) {
    return (
      <div className="card card-padded space-y-3">
        <p className="text-sm text-ink-700 leading-relaxed">
          Connect a Bluesky account first — unfollowing acts as one of your
          accounts, so there has to be one.
        </p>
        <Link href="/accounts" className="btn-primary min-h-11 inline-flex items-center">
          Go to Accounts
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Step 1 ─────────────────────────────────────────────── */}
      <section className="card card-padded space-y-4">
        <StepHeading n={1} of={3} title="Who should Signal unfollow?" />

        <form action={previewDispatch} className="space-y-4">
          <label className="block">
            <span className="stat-label">Acting as</span>
            <select
              name="operator_account_id"
              value={identityId}
              onChange={(e) => setIdentityId(e.target.value)}
              className="input mt-1 w-full min-h-11"
            >
              {props.identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {formatIdentityLabel({
                    id: i.id,
                    handle: i.handle,
                    displayName: i.displayName,
                  })}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-2">
            <legend className="stat-label">
              Choose one source — never a mixture
            </legend>
            {SOURCES.map((s) => {
              const disabled =
                (s.value === "target_followers" && props.targets.length === 0) ||
                (s.value === "follow_campaign" &&
                  props.followCampaigns.length === 0);
              return (
                <label
                  key={s.value}
                  className={`flex gap-3 items-start p-3 rounded-md border min-h-11 ${
                    sourceKind === s.value
                      ? "border-ink-900 bg-ink-50"
                      : "border-ink-200"
                  } ${disabled ? "opacity-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="source_kind"
                    value={s.value}
                    checked={sourceKind === s.value}
                    disabled={disabled}
                    onChange={() => setSourceKind(s.value)}
                    // 20px, not the browser default 13px. The TAP
                    // TARGET is the enclosing label row — measured at
                    // 66-100px in the Chromium sweep — but a 13px glyph
                    // is still hard to see and hard to hit directly,
                    // and "the row is clickable" is not obvious.
                    className="mt-1 shrink-0 h-5 w-5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-900">
                      {s.label}
                    </span>
                    <span className="block text-sm text-ink-600 leading-relaxed">
                      {disabled ? "Nothing available yet." : s.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {sourceKind === "target_followers" ? (
            <label className="block">
              <span className="stat-label">Which list</span>
              <select
                name="target_profile_id"
                value={targetProfileId}
                onChange={(e) => setTargetProfileId(e.target.value)}
                className="input mt-1 w-full min-h-11"
              >
                {props.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.handle ? `@${t.handle}` : t.id} —{" "}
                    {t.candidateCount.toLocaleString()} profiles
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="target_profile_id" value="" />
          )}

          {sourceKind === "follow_campaign" ? (
            <label className="block">
              <span className="stat-label">Which follow campaign</span>
              <select
                name="source_campaign_id"
                value={sourceCampaignId}
                onChange={(e) => setSourceCampaignId(e.target.value)}
                className="input mt-1 w-full min-h-11"
              >
                {props.followCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.succeeded.toLocaleString()} followed
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="source_campaign_id" value="" />
          )}

          <Submit label="Count this list" busy="Counting…" />
        </form>

        {preview.ok ? (
          <p className="text-sm text-ink-800 leading-relaxed" role="status">
            {preview.stillCounting ? (
              <>
                Signal will read your follow list from Bluesky to build this. The
                exact number is not known until it has — it is shown as it goes,
                and nothing is sent until you confirm.
              </>
            ) : (
              <>
                <strong>{preview.eligible.toLocaleString()}</strong> profiles
                can be unfollowed.{" "}
                {preview.protectedExcluded > 0 ? (
                  <>
                    <strong>
                      {preview.protectedExcluded.toLocaleString()}
                    </strong>{" "}
                    are protected and will be left alone.
                  </>
                ) : null}
              </>
            )}
          </p>
        ) : preview.error ? (
          <p className="text-sm text-red-700 leading-relaxed" role="alert">
            {preview.error}
          </p>
        ) : null}
      </section>

      {/* ── Step 2 ─────────────────────────────────────────────── */}
      <section className="card card-padded space-y-4">
        <StepHeading n={2} of={3} title="How fast, and when?" />

        <form action={startDispatch} className="space-y-4">
          <input type="hidden" name="operator_account_id" value={identityId} />
          <input type="hidden" name="source_kind" value={sourceKind} />
          <input
            type="hidden"
            name="target_profile_id"
            value={sourceKind === "target_followers" ? targetProfileId : ""}
          />
          <input
            type="hidden"
            name="source_campaign_id"
            value={sourceKind === "follow_campaign" ? sourceCampaignId : ""}
          />

          <label className="block">
            <span className="stat-label">Name</span>
            <input
              name="name"
              required
              maxLength={120}
              defaultValue="Unfollow clean-up"
              className="input mt-1 w-full min-h-11"
            />
          </label>

          <label className="block">
            <span className="stat-label">Unfollow up to, each day</span>
            <select
              name="requested_daily_quota"
              value={quota}
              onChange={(e) => setQuota(Number(e.target.value))}
              className="input mt-1 w-full min-h-11"
            >
              {UNFOLLOW_DAILY_QUOTA_OPTIONS.map((q) => (
                <option key={q} value={q}>
                  {q.toLocaleString()} a day
                </option>
              ))}
            </select>
            <span className="block text-sm text-ink-600 mt-1 leading-relaxed">
              This is what you are asking for. What Signal actually does each day
              is worked out daily and is often lower — it shares this
              account&rsquo;s{" "}
              {IDENTITY_DAILY_MUTATION_CEILING.toLocaleString()}-action daily
              allowance with any follow campaign on the same account.
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="stat-label">From</span>
              <input
                name="window_start"
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="input mt-1 w-full min-h-11"
              />
            </label>
            <label className="block">
              <span className="stat-label">Until</span>
              <input
                name="window_end"
                type="time"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="input mt-1 w-full min-h-11"
              />
            </label>
          </div>

          <label className="block">
            <span className="stat-label">Time zone</span>
            <select
              name="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="input mt-1 w-full min-h-11"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>

          <label className="flex gap-3 items-start p-3 rounded-md border border-ink-200 min-h-11">
            <input
              type="checkbox"
              name="dry_run"
              value="1"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="mt-1 shrink-0 h-5 w-5"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink-900">
                Dry run — send nothing to Bluesky
              </span>
              <span className="block text-sm text-ink-600 leading-relaxed">
                Every step runs except the deletion. Strongly recommended for the
                first campaign on an account.
              </span>
            </span>
          </label>

          <Submit label="Build the list" busy="Building…" />
        </form>

        {start.error ? (
          <p className="text-sm text-red-700 leading-relaxed" role="alert">
            {start.error}
          </p>
        ) : null}

        {campaignId ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-800 leading-relaxed" role="status">
              {cont.ok
                ? cont.summary
                : ready
                  ? `Ready: ${queued.toLocaleString()} profiles queued.`
                  : `${queued.toLocaleString()} queued so far. Still building — you can leave this page; it continues where it left off.`}
            </p>
            {protectedExcluded > 0 ? (
              <p className="text-sm text-ink-700 leading-relaxed">
                <span className="badge-info">Protected</span>{" "}
                {protectedExcluded.toLocaleString()} profiles were excluded and
                will not be unfollowed.
              </p>
            ) : null}
            {!ready ? (
              <form action={contDispatch}>
                <input type="hidden" name="campaign_id" value={campaignId} />
                <Submit label="Keep building" busy="Building…" />
              </form>
            ) : null}
            {cont.error ? (
              <p className="text-sm text-red-700 leading-relaxed" role="alert">
                {cont.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ── Step 3 ─────────────────────────────────────────────── */}
      <section className="card card-padded space-y-4">
        <StepHeading n={3} of={3} title="Start it" />

        {!campaignId ? (
          <p className="text-sm text-ink-600 leading-relaxed">
            Build the list first.
          </p>
        ) : !ready ? (
          <p className="text-sm text-ink-600 leading-relaxed">
            The list is still being built. Signal will not let a campaign start
            on a half-built list — it would report itself finished when it ran
            out.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-700 leading-relaxed">
              One confirmation, and Signal works through the whole list on its
              own — every day, until it is done. You do not need to come back.
            </p>
            {/* A plain button. It sets state; it does not submit
                anything. The only form that can dispatch lives inside
                the dialog and does not exist until it opens. */}
            <button
              type="button"
              className="btn-danger-solid min-h-11 w-full sm:w-auto"
              onClick={() =>
                setConfirming({
                  campaignId,
                  actorLabel: identityLabel,
                  actorHandle: identity?.handle ?? "",
                  sourceLabel:
                    SOURCES.find((s) => s.value === sourceKind)?.label ??
                    sourceKind,
                  discovered: queued,
                  stillBuilding: !ready,
                  protectedExcluded,
                  remainingEligible: queued,
                  requestedDailyQuota: quota,
                  effectiveDailyQuota: effective,
                  effectiveQuotaReason:
                    effective < quota
                      ? `Reduced to ${effective.toLocaleString()} a day: this account's daily allowance is shared with any follow campaign using it.`
                      : null,
                  timezone,
                  windowLabel: `${windowStart}–${windowEnd}`,
                  estimatedDays: days,
                  dryRun,
                })
              }
            >
              Unfollow people…
            </button>
          </>
        )}
      </section>

      <ConfirmActivationDialog
        facts={confirming}
        dispatch={activateDispatch}
        onCancel={() => setConfirming(null)}
        result={activationResult}
      />

      <p className="text-sm text-ink-500 leading-relaxed">
        Times are shown as {minutesToHhmm(0)}-style 24-hour clock in the time
        zone you pick.
      </p>
    </div>
  );
}
