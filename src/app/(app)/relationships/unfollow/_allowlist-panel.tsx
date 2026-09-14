"use client";
/**
 * The operator's "never unfollow" list.
 *
 * Deliberately a first-class control on the setup screen rather than a
 * setting buried elsewhere. It is the one thing an operator can do
 * BEFORE approving a large campaign that changes what that campaign
 * will do — and it keeps working afterwards: the list is re-checked
 * inside the same transaction that creates each action row, so an entry
 * added today protects a queue frozen last week.
 */

import { useFormState, useFormStatus } from "react-dom";
import {
  addAllowlistEntryAction,
  removeAllowlistEntryAction,
  type ControlResult,
} from "./_actions";
import type { AllowlistEntry } from "@/repositories/bluesky-unfollow-repository";

const EMPTY: ControlResult = { ok: false, error: "" };

function Submit({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

export function AllowlistPanel(props: {
  entries: AllowlistEntry[];
  identities: { id: string; handle: string | null }[];
  canManage: boolean;
}) {
  const [add, addDispatch] = useFormState(addAllowlistEntryAction, EMPTY);
  const [remove, removeDispatch] = useFormState(removeAllowlistEntryAction, EMPTY);

  return (
    <section className="card card-padded space-y-4">
      <div>
        <h2 className="section-title">Never unfollow</h2>
        <p className="text-sm text-ink-600 mt-1 leading-relaxed">
          Profiles on this list are skipped by every unfollow campaign — including
          campaigns whose list was built before you added them. Your own account is
          always protected and cannot be removed.
        </p>
      </div>

      {props.entries.length > 0 ? (
        <ul className="list-none p-0 m-0 space-y-2">
          {props.entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap gap-2 items-center justify-between border border-ink-200 rounded-md p-3"
            >
              <span className="min-w-0">
                <span className="block text-sm text-ink-900 break-all">
                  {e.subjectHandle ? `@${e.subjectHandle}` : e.subjectDid}
                </span>
                {e.reason ? (
                  <span className="block text-sm text-ink-600 break-words">
                    {e.reason}
                  </span>
                ) : null}
                <span className="block text-sm text-ink-500">
                  {e.operatorAccountId
                    ? "One account"
                    : "Every account in this workspace"}
                </span>
              </span>
              {props.canManage ? (
                <form action={removeDispatch} className="shrink-0">
                  <input type="hidden" name="entry_id" value={e.id} />
                  <Submit
                    label="Remove"
                    className="btn-secondary min-h-11"
                  />
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-600 leading-relaxed">
          Nothing on the list yet.
        </p>
      )}

      {props.canManage ? (
        <form action={addDispatch} className="space-y-3">
          <label className="block">
            <span className="stat-label">Bluesky account identifier (DID)</span>
            <input
              name="subject_did"
              placeholder="did:plc:…"
              className="input mt-1 w-full min-h-11"
              required
            />
          </label>
          <label className="block">
            <span className="stat-label">Handle, as you know it (optional)</span>
            <input name="subject_handle" className="input mt-1 w-full min-h-11" />
          </label>
          <label className="block">
            <span className="stat-label">Why (optional)</span>
            <input name="reason" className="input mt-1 w-full min-h-11" />
          </label>
          <label className="block">
            <span className="stat-label">Applies to</span>
            <select
              name="operator_account_id"
              className="input mt-1 w-full min-h-11"
            >
              <option value="">Every account in this workspace</option>
              {props.identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.handle ? `@${i.handle}` : i.id}
                </option>
              ))}
            </select>
          </label>
          <Submit label="Add to Never unfollow" className="btn-primary min-h-11 w-full sm:w-auto" />
        </form>
      ) : null}

      {add.ok ? (
        <p className="text-sm text-emerald-800 leading-relaxed" role="status">
          {add.summary}
        </p>
      ) : add.error ? (
        <p className="text-sm text-red-700 leading-relaxed" role="alert">
          {add.error}
        </p>
      ) : null}
      {remove.ok ? (
        <p className="text-sm text-emerald-800 leading-relaxed" role="status">
          {remove.summary}
        </p>
      ) : remove.error ? (
        <p className="text-sm text-red-700 leading-relaxed" role="alert">
          {remove.error}
        </p>
      ) : null}
    </section>
  );
}
