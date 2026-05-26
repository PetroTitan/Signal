"use client";

/**
 * Phase F7.0 — identity-level factual grounding editor.
 *
 * Read-only by default; an "Edit" affordance flips into a small
 * form that calls `updateIdentitySourcesAction`. Pure UI; the
 * server action owns validation.
 *
 * Why it exists
 * -------------
 * Generation flows (Codex / signal.generate_*) ground topics in
 * `growth_accounts.source_website_url` so drafts never default to
 * internal infrastructure / debugging conversations. The operator
 * needs a visible place to set + edit it.
 */

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  updateIdentitySourcesAction,
  type UpdateIdentitySourcesResult,
} from "./_actions";

const initial: UpdateIdentitySourcesResult = { ok: false, error: "" };

export interface IdentitySourcesEditorProps {
  accountId: string;
  initialSourceWebsiteUrl: string | null;
  initialReferenceUrls: ReadonlyArray<string>;
}

export function IdentitySourcesEditor(props: IdentitySourcesEditorProps) {
  const [state, action] = useFormState(updateIdentitySourcesAction, initial);
  const [editing, setEditing] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(
    props.initialSourceWebsiteUrl ?? "",
  );
  const [referenceDraft, setReferenceDraft] = useState(
    props.initialReferenceUrls.join("\n"),
  );
  const safe = state ?? initial;

  if (!editing) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Factual source
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn-ghost text-[11px]"
          >
            {props.initialSourceWebsiteUrl ? "Edit" : "Add"}
          </button>
        </div>
        {props.initialSourceWebsiteUrl ? (
          <div className="space-y-1">
            <p className="text-xs text-ink-800 font-mono break-all">
              {props.initialSourceWebsiteUrl}
            </p>
            {props.initialReferenceUrls.length > 0 ? (
              <ul className="text-[11px] text-ink-600 space-y-0.5">
                {props.initialReferenceUrls.map((u) => (
                  <li key={u} className="font-mono break-all">
                    · {u}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[10px] text-ink-500 leading-relaxed mt-1">
              This identity generates content grounded in the above
              {props.initialReferenceUrls.length > 0 ? " sources." : " site."}
            </p>
          </div>
        ) : (
          <p className="text-xs text-amber-700 leading-relaxed">
            No source website set. Generation will work, but without
            factual grounding it may drift into off-brand topics. Add the
            canonical site this identity publishes about.
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="account_id" value={props.accountId} />
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Source website
        </span>
        <input
          type="url"
          name="source_website_url"
          value={sourceDraft}
          onChange={(e) => setSourceDraft(e.currentTarget.value)}
          placeholder="https://www.example.com"
          className="input w-full text-sm font-mono mt-1"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Reference URLs (one per line)
        </span>
        <textarea
          name="reference_urls"
          value={referenceDraft}
          onChange={(e) => setReferenceDraft(e.currentTarget.value)}
          rows={3}
          placeholder={"https://docs.example.com\nhttps://blog.example.com"}
          className="input w-full text-sm font-mono leading-relaxed mt-1"
        />
      </label>
      {!safe.ok && safe.error ? (
        <p className="text-[11px] text-amber-700">{safe.error}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <SaveButton />
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setSourceDraft(props.initialSourceWebsiteUrl ?? "");
            setReferenceDraft(props.initialReferenceUrls.join("\n"));
          }}
          className="btn-ghost text-[11px]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-[11px] disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save sources"}
    </button>
  );
}
