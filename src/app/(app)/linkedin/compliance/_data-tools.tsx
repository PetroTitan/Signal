"use client";

import { useFormState, useFormStatus } from "react-dom";
import { deleteProfileAction, purgeExpiredAction, type ComplianceResult } from "../_actions";

const EMPTY: ComplianceResult = { ok: false, error: "" };

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * Export (a download of everything Signal holds about one profile),
 * deletion (a data-subject request: rows removed, the key kept on the
 * suppression list) and the retention purge. Deletion and purge need an
 * owner or admin; the server checks again.
 */
export function DataTools(props: { canEdit: boolean; canDelete: boolean; expiredCount: number; today: string }) {
  const [del, delDispatch] = useFormState(deleteProfileAction, EMPTY);
  const [purge, purgeDispatch] = useFormState(purgeExpiredAction, EMPTY);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <form method="get" action="/api/linkedin/profile-export" className="card card-padded space-y-3" aria-labelledby="export-heading">
        <h3 id="export-heading" className="font-medium text-ink-900">Export a person&rsquo;s data</h3>
        <p className="text-sm text-ink-600 leading-relaxed">
          A JSON file with every lead row, campaign membership and task Signal holds for one public profile URL. The export
          is recorded in the audit history.
        </p>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Public profile URL</span>
          <input name="profile" required className="input w-full min-h-11" placeholder="https://www.linkedin.com/in/…" disabled={!props.canEdit} />
        </label>
        <button type="submit" className="btn-secondary min-h-11 w-full sm:w-auto" disabled={!props.canEdit}>
          Download export
        </button>
      </form>

      <form action={delDispatch} className="card card-padded space-y-3" aria-labelledby="delete-heading">
        <h3 id="delete-heading" className="font-medium text-ink-900">Delete a person&rsquo;s data</h3>
        <p className="text-sm text-ink-600 leading-relaxed">
          Removes every lead row, campaign membership and task for one profile. The profile key alone stays on the
          suppression list, marked as a deletion request, so a later import cannot bring the person back. Cannot be undone.
        </p>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Public profile URL</span>
          <input name="profile" required className="input w-full min-h-11" placeholder="https://www.linkedin.com/in/…" disabled={!props.canDelete} />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Reason (optional)</span>
          <input name="reason" maxLength={500} className="input w-full min-h-11" disabled={!props.canDelete} />
        </label>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 shrink-0" disabled={!props.canDelete} />
          <span>I understand this deletes the data and cannot be undone.</span>
        </label>
        {del.error ? <p role="alert" className="text-sm text-red-700">{del.error}</p> : null}
        {del.ok ? <p role="status" className="text-sm text-green-800">{del.message}</p> : null}
        {props.canDelete ? (
          <Submit label="Delete this person's data" className="btn-danger-solid min-h-11 w-full sm:w-auto" />
        ) : (
          <p className="text-sm text-ink-600">Deleting data needs an owner or admin.</p>
        )}
      </form>

      <form action={purgeDispatch} className="card card-padded space-y-3 sm:col-span-2" aria-labelledby="purge-heading">
        <h3 id="purge-heading" className="font-medium text-ink-900">Retention purge</h3>
        <p className="text-sm text-ink-600 leading-relaxed">
          Deletes leads whose &ldquo;delete on&rdquo; date is {props.today} or earlier, up to 500 at a time. Their memberships and
          tasks go with them; the audit history keeps the count. As of today, {props.expiredCount.toLocaleString("en-GB")} lead
          {props.expiredCount === 1 ? " is" : "s are"} past their date.
        </p>
        <label className="flex items-start gap-3 min-h-11 text-sm">
          <input type="checkbox" name="confirm" required className="mt-1 h-5 w-5 shrink-0" disabled={!props.canDelete} />
          <span>I understand the expired leads will be deleted.</span>
        </label>
        {purge.error ? <p role="alert" className="text-sm text-red-700">{purge.error}</p> : null}
        {purge.ok ? <p role="status" className="text-sm text-green-800">{purge.message}</p> : null}
        {props.canDelete ? (
          <Submit label="Delete expired leads" className="btn-danger min-h-11 w-full sm:w-auto" />
        ) : (
          <p className="text-sm text-ink-600">Running the purge needs an owner or admin.</p>
        )}
      </form>
    </div>
  );
}
