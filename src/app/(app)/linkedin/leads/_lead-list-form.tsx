"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createLeadListAction, type CreateLeadListResult } from "../_actions";

const EMPTY: CreateLeadListResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={pending}>
      {pending ? "Creating…" : "Create list"}
    </button>
  );
}

export function LeadListForm() {
  const [state, dispatch] = useFormState(createLeadListAction, EMPTY);
  return (
    <form action={dispatch} className="card card-padded space-y-4" aria-labelledby="new-list-heading">
      <h3 id="new-list-heading" className="section-title">New list</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Name</span>
          <input name="name" required maxLength={120} className="input w-full min-h-11" />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">Where does this list come from?</legend>
        <p className="text-sm text-ink-600 leading-relaxed">
          Required. Signal stores what you say here with every person in the list. It is your statement, kept as evidence of what you told us.
        </p>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="radio" name="source_type" value="customer_csv" defaultChecked className="mt-1 h-5 w-5 shrink-0" />
          <span>A file my organisation already holds (CRM export, event list, customers)</span>
        </label>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="radio" name="source_type" value="customer_pasted" className="mt-1 h-5 w-5 shrink-0" />
          <span>Profile URLs I will paste in myself</span>
        </label>
      </fieldset>
      <label className="block text-sm">
        <span className="block font-medium text-ink-800 mb-1">Note on the source (optional)</span>
        <textarea name="source_note" maxLength={1000} rows={2} className="input w-full" placeholder="e.g. Attendees of our March webinar who agreed to follow-up" />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700">{state.error}</p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-green-800">List created. Select it above to import.</p>
      ) : null}
      <Submit />
    </form>
  );
}
