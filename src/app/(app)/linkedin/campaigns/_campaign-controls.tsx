"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { LinkedInCampaignStatus } from "@/lib/supabase/types";
import { activateCampaignAction, cancelCampaignAction, pauseCampaignAction, type CampaignResult } from "../_actions";

const EMPTY: CampaignResult = { ok: false, error: "" };

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * Start / pause / resume / cancel for one campaign. Cancel is
 * destructive for open tasks, so it opens a modal confirmation with a
 * checkbox; the server refuses without the tick.
 */
export function CampaignControls(props: { campaignId: string; status: LinkedInCampaignStatus; name: string }) {
  const [activate, activateDispatch] = useFormState(activateCampaignAction, EMPTY);
  const [pause, pauseDispatch] = useFormState(pauseCampaignAction, EMPTY);
  const [cancel, cancelDispatch] = useFormState(cancelCampaignAction, EMPTY);
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (confirming && !node.open) node.showModal();
    if (!confirming && node.open) node.close();
  }, [confirming]);
  useEffect(() => () => { dialogRef.current?.close(); }, []);
  useEffect(() => {
    if (cancel.ok) setConfirming(false);
  }, [cancel.ok]);

  const final = props.status === "completed" || props.status === "cancelled";
  const message = activate.ok ? activate.message : pause.ok ? pause.message : cancel.ok ? cancel.message : null;
  const error = activate.error || pause.error || (confirming ? "" : cancel.error);

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        {props.status === "draft" || props.status === "paused" ? (
          <form action={activateDispatch}>
            <input type="hidden" name="campaign_id" value={props.campaignId} />
            <Submit label={props.status === "draft" ? "Start preparing tasks" : "Resume"} className="btn-primary min-h-11 w-full sm:w-auto" />
          </form>
        ) : null}
        {props.status === "active" ? (
          <form action={pauseDispatch}>
            <input type="hidden" name="campaign_id" value={props.campaignId} />
            <Submit label="Pause" className="btn-secondary min-h-11 w-full sm:w-auto" />
          </form>
        ) : null}
        {!final ? (
          <button type="button" onClick={() => setConfirming(true)} className="btn-danger min-h-11 w-full sm:w-auto">
            Cancel campaign…
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {message ? <p role="status" className="text-sm text-green-800">{message}</p> : null}

      <dialog
        ref={dialogRef}
        aria-labelledby={`cancel-title-${props.campaignId}`}
        onCancel={() => setConfirming(false)}
        className="w-[calc(100vw-2rem)] max-w-md max-h-[90vh] overflow-y-auto rounded-lg border border-ink-200 p-0 backdrop:bg-ink-900/40"
      >
        <form action={cancelDispatch} className="p-4 sm:p-6 space-y-4">
          <h3 id={`cancel-title-${props.campaignId}`} className="section-title">Cancel &ldquo;{props.name}&rdquo;?</h3>
          <p className="text-sm text-ink-800 leading-relaxed">
            Every open task is cancelled and every person still waiting is marked cancelled. What you already confirmed
            stays in the history. This cannot be undone.
          </p>
          <input type="hidden" name="campaign_id" value={props.campaignId} />
          <label className="flex items-start gap-3 min-h-11 text-sm">
            <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 shrink-0" />
            <span>I understand the open tasks will be cancelled.</span>
          </label>
          {confirming && cancel.error ? <p role="alert" className="text-sm text-red-700">{cancel.error}</p> : null}
          <div className="flex flex-col sm:flex-row flex-wrap gap-2">
            <Submit label="Cancel campaign" className="btn-danger-solid min-h-11 w-full sm:w-auto" />
            <button type="button" onClick={() => setConfirming(false)} className="btn-secondary min-h-11 w-full sm:w-auto">
              Keep it
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
