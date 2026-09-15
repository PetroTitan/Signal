"use client";

import { useFormState, useFormStatus } from "react-dom";
import { addSuppressionAction, removeSuppressionAction, type ComplianceResult } from "../_actions";

const EMPTY: ComplianceResult = { ok: false, error: "" };

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  operator: "Added by an operator",
  import: "From an import",
  task: "From a task",
  unsubscribe: "They asked to be left alone",
  deletion_request: "Deletion request",
};

export function SuppressionPanel(props: {
  entries: { id: string; profileKey: string; url: string; reason: string | null; source: string; createdAt: string }[];
  canEdit: boolean;
}) {
  const [add, addDispatch] = useFormState(addSuppressionAction, EMPTY);
  const [remove, removeDispatch] = useFormState(removeSuppressionAction, EMPTY);

  return (
    <div className="space-y-4">
      {props.canEdit ? (
        <form action={addDispatch} className="card card-padded space-y-3" aria-labelledby="add-suppression-heading">
          <h3 id="add-suppression-heading" className="font-medium text-ink-900">Add a person</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="block font-medium text-ink-800 mb-1">Public profile URL</span>
              <input name="profile" required className="input w-full min-h-11" placeholder="https://www.linkedin.com/in/…" />
            </label>
            <label className="block text-sm">
              <span className="block font-medium text-ink-800 mb-1">Reason (optional)</span>
              <input name="reason" maxLength={500} className="input w-full min-h-11" />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink-800">Why</legend>
            <label className="flex items-start gap-3 min-h-11 text-sm">
              <input type="radio" name="source" value="operator" defaultChecked className="mt-1 h-5 w-5 shrink-0" />
              <span>Our decision</span>
            </label>
            <label className="flex items-start gap-3 min-h-11 text-sm">
              <input type="radio" name="source" value="unsubscribe" className="mt-1 h-5 w-5 shrink-0" />
              <span>They asked us to stop</span>
            </label>
          </fieldset>
          {add.error ? <p role="alert" className="text-sm text-red-700">{add.error}</p> : null}
          {add.ok ? <p role="status" className="text-sm text-green-800">{add.message}</p> : null}
          <Submit label="Add to suppression list" className="btn-primary min-h-11 w-full sm:w-auto" />
        </form>
      ) : null}

      {props.entries.length === 0 ? (
        <p className="card card-padded text-sm text-ink-600">Nobody on the list.</p>
      ) : (
        <ul className="list-none p-0 m-0 space-y-2">
          {props.entries.map((e) => (
            <li key={e.id} className="card card-padded flex flex-wrap gap-2 items-start justify-between">
              <span className="min-w-0 space-y-1">
                <span className="block text-sm text-ink-900 break-all">{e.url}</span>
                <span className="block text-sm text-ink-600">
                  {SOURCE_LABELS[e.source] ?? e.source} · {new Date(e.createdAt).toLocaleDateString("en-GB")}
                  {e.reason ? ` · ${e.reason}` : ""}
                </span>
              </span>
              {props.canEdit && e.source !== "deletion_request" ? (
                <details className="text-sm shrink-0">
                  <summary className="cursor-pointer min-h-11 inline-flex items-center font-medium text-ink-800">Remove…</summary>
                  <form action={removeDispatch} className="mt-2 space-y-2">
                    <input type="hidden" name="profile_key" value={e.profileKey} />
                    <label className="flex items-start gap-3 min-h-11">
                      <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 shrink-0" />
                      <span>Campaigns may prepare tasks for this person again.</span>
                    </label>
                    <Submit label="Remove from list" className="btn-danger min-h-11 w-full sm:w-auto" />
                  </form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {remove.error ? <p role="alert" className="text-sm text-red-700">{remove.error}</p> : null}
      {remove.ok ? <p role="status" className="text-sm text-green-800">{remove.message}</p> : null}
    </div>
  );
}
