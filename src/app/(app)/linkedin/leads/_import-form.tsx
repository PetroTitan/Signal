"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { LinkedInSourceType } from "@/lib/supabase/types";
import { importLeadsAction, type ImportResult } from "../_actions";

const EMPTY: ImportResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={pending}>
      {pending ? "Importing…" : "Import"}
    </button>
  );
}

/**
 * The import form. The file is posted to the server and parsed there;
 * this component never holds its contents. Only the counts come back.
 */
export function ImportForm(props: { leadListId: string; defaultSourceType: LinkedInSourceType }) {
  const [state, dispatch] = useFormState(importLeadsAction, EMPTY);
  return (
    <form action={dispatch} className="card card-padded space-y-4" aria-labelledby="import-form-heading" encType="multipart/form-data">
      <h3 id="import-form-heading" className="section-title">Import profile URLs</h3>
      <input type="hidden" name="lead_list_id" value={props.leadListId} />
      <p className="text-sm text-ink-600 leading-relaxed">
        A CSV with a <code>url</code> column (name, company and title columns are used if present), or one public
        profile URL per line. Up to 1 MB and 10,000 rows. Signal stores the URL as you gave it and does not visit it.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">File</span>
          <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="input w-full min-h-11" />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Or paste URLs</span>
          <textarea name="pasted" rows={4} className="input w-full" placeholder={"https://www.linkedin.com/in/example\nhttps://www.linkedin.com/in/another"} />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">Where do these profiles come from?</legend>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="radio" name="source_type" value="customer_csv" defaultChecked={props.defaultSourceType !== "customer_pasted"} className="mt-1 h-5 w-5 shrink-0" />
          <span>A file my organisation already holds</span>
        </label>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="radio" name="source_type" value="customer_pasted" defaultChecked={props.defaultSourceType === "customer_pasted"} className="mt-1 h-5 w-5 shrink-0" />
          <span>Profile URLs I pasted in</span>
        </label>
      </fieldset>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Why may these people be processed? (optional)</span>
          <textarea name="processing_basis_note" rows={3} maxLength={1000} className="input w-full" placeholder="e.g. Existing customers; contract relationship" />
          <span className="block text-ink-600 mt-1 leading-relaxed">
            Your statement, kept with each lead. It is evidence of what you told us, not a legal assessment.
          </span>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Delete on (optional)</span>
          <input type="date" name="retention_until" className="input w-full min-h-11" />
          <span className="block text-ink-600 mt-1 leading-relaxed">Leads past this date are deleted by the retention purge on the Compliance page.</span>
        </label>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700">{state.error}</p>
      ) : null}
      {state.ok ? (
        <div role="status" className="text-sm text-ink-800 space-y-1">
          <p className="font-medium">
            {state.alreadyImported ? "This exact file was already imported into this list." : state.finished ? "Import finished." : "Import in progress; send the same file again to continue."}
          </p>
          <p>
            {state.inserted} inserted · {state.duplicates} duplicates · {state.invalid} invalid · {state.suppressed} suppressed (recorded, never contacted)
          </p>
          {state.invalid + state.duplicates > 0 ? (
            <a href={`/api/linkedin/imports/${state.jobId}/errors`} className="underline text-signal-800 inline-flex items-center min-h-11">
              Download the row-by-row report
            </a>
          ) : null}
        </div>
      ) : null}
      <Submit />
    </form>
  );
}
