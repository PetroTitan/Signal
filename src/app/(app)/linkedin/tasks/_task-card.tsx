"use client";

import { useState, useTransition } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { LinkedInTaskKind, LinkedInTaskState } from "@/lib/supabase/types";
import { TASK_KIND_LABELS, TASK_STATE_LABELS } from "@/core/linkedin-sales/state";
import {
  confirmTaskAction,
  recordCopiedAction,
  recordOpenedAction,
  skipTaskAction,
  suggestDraftAction,
  suppressFromTaskAction,
  type SuggestResult,
  type TaskResult,
} from "../_actions";

const EMPTY: TaskResult = { ok: false, error: "" };
const EMPTY_SUGGEST: SuggestResult = { ok: false, error: "" };

export interface TaskCardProps {
  task: {
    id: string;
    kind: LinkedInTaskKind;
    state: LinkedInTaskState;
    draftText: string | null;
    profileUrl: string;
    openedAt: string | null;
    copiedAt: string | null;
  };
  lead: { name: string | null; company: string | null; title: string | null };
  campaignName: string;
  canEdit: boolean;
}

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * One manual task. Five separate controls, five separate meanings:
 *   Copy draft            → recorded as "copied"; nothing sent
 *   Open in LinkedIn      → a link to the public profile in a new tab;
 *                           recorded as "opened"; nothing done
 *   Mark completed        → the operator's statement that THEY did it
 *   Skip                  → ends this person's sequence, with a reason
 *   Add to suppression    → never prepare this person again, anywhere
 * Opening or copying never completes the task.
 */
export function TaskCard({ task, lead, campaignName, canEdit }: TaskCardProps) {
  const [confirm, confirmDispatch] = useFormState(confirmTaskAction, EMPTY);
  const [skip, skipDispatch] = useFormState(skipTaskAction, EMPTY);
  const [suppress, suppressDispatch] = useFormState(suppressFromTaskAction, EMPTY);
  const [suggest, suggestDispatch] = useFormState(suggestDraftAction, EMPTY_SUGGEST);
  const [live, setLive] = useState<string>("");
  const [pending, startTransition] = useTransition();

  const copy = async (text: string, record: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      setLive(record ? "Draft copied to your clipboard. Nothing was sent." : "Suggestion copied to your clipboard. Nothing was sent.");
    } catch {
      setLive("Your browser did not allow copying. Select the text and copy it yourself.");
      return;
    }
    if (record) startTransition(async () => { await recordCopiedAction(task.id); });
  };

  const opened = () => startTransition(async () => { await recordOpenedAction(task.id); });

  const done = confirm.ok || skip.ok || suppress.ok;
  const stateLabel = TASK_STATE_LABELS[task.state];

  return (
    <article aria-labelledby={`task-${task.id}-title`} className="card card-padded space-y-4">
      <header className="space-y-1">
        <p className="text-sm text-ink-600">{campaignName}</p>
        <h3 id={`task-${task.id}-title`} className="font-medium text-ink-900 break-words">
          {TASK_KIND_LABELS[task.kind]}
        </h3>
        <p className="text-sm text-ink-800 break-words">
          {lead.name ?? "No name given"}
          {lead.title ? ` · ${lead.title}` : ""}
          {lead.company ? ` · ${lead.company}` : ""}
        </p>
        <p className="text-sm text-ink-600 break-all">{task.profileUrl}</p>
        <p className="text-sm">
          <span className="badge badge-info">{done ? "Recorded" : stateLabel}</span>
          {task.openedAt ? <span className="ml-2 text-ink-600">Profile opened by you at {new Date(task.openedAt).toLocaleTimeString("en-GB")}.</span> : null}
          {task.copiedAt ? <span className="ml-2 text-ink-600">Draft copied by you at {new Date(task.copiedAt).toLocaleTimeString("en-GB")}.</span> : null}
        </p>
      </header>

      {task.draftText ? (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="block font-medium text-ink-800 mb-1">Draft (you copy it; Signal does not send it)</span>
            <textarea readOnly value={task.draftText} rows={5} className="input w-full font-mono text-sm" />
          </label>
          <div className="flex flex-col sm:flex-row flex-wrap gap-2">
            <button type="button" onClick={() => copy(task.draftText ?? "", true)} disabled={!canEdit || done || pending} className="btn-secondary min-h-11 w-full sm:w-auto">
              Copy draft
            </button>
            {canEdit && !done ? (
              <form action={suggestDispatch}>
                <input type="hidden" name="task_id" value={task.id} />
                <Submit label="Suggest a calmer variant" className="btn-ghost min-h-11 w-full sm:w-auto" />
              </form>
            ) : null}
          </div>
          {suggest.ok ? (
            <div className="space-y-2 border border-ink-200 rounded-md p-3">
              <p className="text-sm text-ink-800">
                A suggestion from {suggest.providerLabel}. Review it; it is not sent and not saved to the task.
                {suggest.flags.length > 0 ? ` Flags: ${suggest.flags.join(", ")}.` : ""}
              </p>
              <textarea readOnly value={suggest.text} rows={5} className="input w-full font-mono text-sm" aria-label="Suggested variant" />
              <button type="button" onClick={() => copy(suggest.text, false)} className="btn-secondary min-h-11 w-full sm:w-auto">
                Copy suggestion
              </button>
            </div>
          ) : suggest.error ? (
            <p role="alert" className="text-sm text-red-700">{suggest.error}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        <a
          href={task.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={canEdit && !done ? opened : undefined}
          className="btn-nav min-h-11 w-full sm:w-auto"
        >
          Open in LinkedIn<span className="sr-only"> (opens the public profile in a new tab)</span>
        </a>
      </div>
      <p className="text-sm text-ink-600 leading-relaxed">
        Opening the profile and copying the draft are recorded as things you did in Signal. Neither completes the task.
        When you have done the step on LinkedIn yourself, mark it completed below.
      </p>

      {canEdit && !done ? (
        <>
          <form action={confirmDispatch} className="space-y-2">
            <input type="hidden" name="task_id" value={task.id} />
            <label className="flex items-start gap-3 min-h-11 text-sm">
              <input type="checkbox" name="attest" required className="mt-1 h-5 w-5 shrink-0" />
              <span>I did this step on LinkedIn myself.</span>
            </label>
            <Submit label="Mark completed" className="btn-primary min-h-11 w-full sm:w-auto" />
            {confirm.error ? <p role="alert" className="text-sm text-red-700">{confirm.error}</p> : null}
          </form>

          <details className="text-sm">
            <summary className="cursor-pointer min-h-11 inline-flex items-center font-medium text-ink-800">Skip this task…</summary>
            <form action={skipDispatch} className="mt-2 space-y-2">
              <input type="hidden" name="task_id" value={task.id} />
              <label className="block">
                <span className="block font-medium text-ink-800 mb-1">Why? (kept with the task)</span>
                <textarea name="reason" required maxLength={500} rows={2} className="input w-full" />
              </label>
              <Submit label="Skip and end this person's sequence" className="btn-secondary min-h-11 w-full sm:w-auto" />
              {skip.error ? <p role="alert" className="text-sm text-red-700">{skip.error}</p> : null}
            </form>
          </details>

          <details className="text-sm">
            <summary className="cursor-pointer min-h-11 inline-flex items-center font-medium text-red-800">Add to suppression list…</summary>
            <form action={suppressDispatch} className="mt-2 space-y-2">
              <input type="hidden" name="task_id" value={task.id} />
              <p className="text-ink-800 leading-relaxed">
                This person will never be prepared again by any campaign in this workspace. Their other waiting steps end now.
              </p>
              <label className="block">
                <span className="block font-medium text-ink-800 mb-1">Reason (optional)</span>
                <input name="reason" maxLength={500} className="input w-full min-h-11" />
              </label>
              <label className="flex items-start gap-3 min-h-11">
                <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 shrink-0" />
                <span>I understand this applies to every campaign.</span>
              </label>
              <Submit label="Add to suppression list" className="btn-danger-solid min-h-11 w-full sm:w-auto" />
              {suppress.error ? <p role="alert" className="text-sm text-red-700">{suppress.error}</p> : null}
            </form>
          </details>
        </>
      ) : null}

      {done ? (
        <p role="status" className="text-sm text-green-800">{confirm.ok ? confirm.message : skip.ok ? skip.message : suppress.ok ? suppress.message : ""}</p>
      ) : null}
      <p aria-live="polite" className="text-sm text-ink-600 min-h-5">{live}</p>
    </article>
  );
}
