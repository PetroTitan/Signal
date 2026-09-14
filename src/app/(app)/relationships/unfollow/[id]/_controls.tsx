"use client";
/**
 * Operator control over a running unfollow campaign.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * There is no "undo all" button, and there will not be one. Re-following
 * tens of thousands of people is a bulk interaction of exactly the kind
 * the provider's guidelines warn about; dressing it as "rollback" would
 * present a second mass action as a safety feature. Cancelling stops
 * future work and says so in those words.
 *
 * Every destructive control confirms first, and the confirmation is a
 * typed word rather than a click, so a stray Enter on a focused button
 * cannot end a campaign.
 */

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  cancelUnfollowCampaignAction,
  pauseUnfollowCampaignAction,
  resumeUnfollowCampaignAction,
  stopIdentityAction,
  type ControlResult,
} from "../_actions";

const EMPTY: ControlResult = { ok: false, error: "" };

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

function Notice({ state }: { state: ControlResult }) {
  if (state.ok) {
    return (
      <p
        className="text-sm text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md p-3 leading-relaxed"
        role="status"
      >
        {state.summary}
      </p>
    );
  }
  if (state.error) {
    return (
      <p
        className="text-sm text-red-900 bg-red-50 border border-red-200 rounded-md p-3 leading-relaxed"
        role="alert"
      >
        {state.error}
      </p>
    );
  }
  return null;
}

export function CampaignControls(props: {
  campaignId: string;
  identityId: string;
  identityLabel: string;
  status: string;
  canManage: boolean;
}) {
  const [pause, pauseDispatch] = useFormState(pauseUnfollowCampaignAction, EMPTY);
  const [resume, resumeDispatch] = useFormState(
    resumeUnfollowCampaignAction,
    EMPTY,
  );
  const [cancel, cancelDispatch] = useFormState(
    cancelUnfollowCampaignAction,
    EMPTY,
  );
  const [stop, stopDispatch] = useFormState(stopIdentityAction, EMPTY);

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);

  if (!props.canManage) {
    return (
      <p className="text-sm text-ink-600 leading-relaxed">
        Your role can view this campaign but not change it.
      </p>
    );
  }

  const running =
    props.status === "active" ||
    props.status === "rate_limited" ||
    props.status === "reauthorization_required";
  const paused = props.status === "paused";
  const terminal = props.status === "completed" || props.status === "cancelled";

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
        {running ? (
          <form action={pauseDispatch} className="w-full sm:w-auto">
            <input type="hidden" name="campaign_id" value={props.campaignId} />
            <Submit
              label="Pause now"
              className="btn-secondary min-h-11 w-full sm:w-auto"
            />
          </form>
        ) : null}

        {paused ? (
          <form action={resumeDispatch} className="w-full sm:w-auto">
            <input type="hidden" name="campaign_id" value={props.campaignId} />
            <Submit
              label="Resume"
              className="btn-primary min-h-11 w-full sm:w-auto"
            />
          </form>
        ) : null}

        {!terminal ? (
          <button
            type="button"
            className="btn-secondary min-h-11 w-full sm:w-auto"
            onClick={() => setConfirmingCancel((v) => !v)}
            aria-expanded={confirmingCancel}
          >
            Cancel future work
          </button>
        ) : null}

        <button
          type="button"
          className="btn-danger-solid min-h-11 w-full sm:w-auto"
          onClick={() => setConfirmingStop((v) => !v)}
          aria-expanded={confirmingStop}
        >
          Stop this identity
        </button>

        <a
          href={`/api/relationships/unfollow-export?campaign=${encodeURIComponent(
            props.campaignId,
          )}`}
          className="btn-secondary min-h-11 w-full sm:w-auto inline-flex items-center justify-center"
        >
          Export results
        </a>
      </div>

      {confirmingCancel ? (
        <div className="border border-ink-200 rounded-md p-3 space-y-3">
          <p className="text-sm text-ink-800 leading-relaxed">
            This stops all remaining work.{" "}
            <strong>
              It does not re-follow anyone already unfollowed — Signal has no
              way to undo an unfollow, and offering one would be a second mass
              action pretending to be a safety feature.
            </strong>
          </p>
          {/* The form exists only while this panel is open, so the
              collapse path cannot dispatch. */}
          <form action={cancelDispatch} className="flex flex-col sm:flex-row gap-2">
            <input type="hidden" name="campaign_id" value={props.campaignId} />
            <input type="hidden" name="confirm" value="cancel" />
            <Submit
              label="Cancel future work"
              className="btn-danger-solid min-h-11 w-full sm:w-auto"
            />
            <button
              type="button"
              className="btn-secondary min-h-11 w-full sm:w-auto"
              onClick={() => setConfirmingCancel(false)}
            >
              Keep it running
            </button>
          </form>
        </div>
      ) : null}

      {confirmingStop ? (
        <div className="border border-red-200 bg-red-50 rounded-md p-3 space-y-3">
          <p className="text-sm text-red-900 leading-relaxed">
            Stops <strong>every</strong> campaign acting as{" "}
            <span className="break-all">{props.identityLabel}</span> —
            following and unfollowing alike — until you release it. Nothing in
            flight is undone; nothing new is started.
          </p>
          <form action={stopDispatch} className="flex flex-col sm:flex-row gap-2">
            <input
              type="hidden"
              name="operator_account_id"
              value={props.identityId}
            />
            <input
              type="hidden"
              name="reason"
              value="Stopped from the campaign page."
            />
            <Submit
              label="Stop this identity"
              className="btn-danger-solid min-h-11 w-full sm:w-auto"
            />
            <button
              type="button"
              className="btn-secondary min-h-11 w-full sm:w-auto"
              onClick={() => setConfirmingStop(false)}
            >
              Leave it running
            </button>
          </form>
        </div>
      ) : null}

      <Notice state={pause} />
      <Notice state={resume} />
      <Notice state={cancel} />
      <Notice state={stop} />
    </div>
  );
}
