"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  updateVoiceProfileAction,
  type UpdateVoiceProfileResult,
} from "./_actions";

const initial: UpdateVoiceProfileResult = { ok: false, error: "" };

interface VoiceProfileEditorProps {
  accountId: string;
  initialValue: string | null;
  platformHint: string | null;
}

export function VoiceProfileEditor(props: VoiceProfileEditorProps) {
  const [state, action] = useFormState(updateVoiceProfileAction, initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.initialValue ?? "");
  const safe = state ?? initial;
  const value = props.initialValue?.trim() ?? "";

  if (!editing) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            How this identity writes
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn-ghost text-[11px]"
          >
            {value.length > 0 ? "Edit" : "Add"}
          </button>
        </div>
        {value.length > 0 ? (
          <p className="text-xs text-ink-700 leading-relaxed whitespace-pre-wrap">
            {value}
          </p>
        ) : (
          <p className="text-xs text-ink-400 italic leading-relaxed">
            {props.platformHint ??
              "Describe how this identity writes — voice, tone, what to avoid."}
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          How this identity writes
        </span>
        <span className="text-[10px] text-ink-400">
          {draft.length} / 1500
        </span>
      </div>
      <input type="hidden" name="account_id" value={props.accountId} />
      <textarea
        name="voice_profile"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        maxLength={1500}
        placeholder={
          props.platformHint ??
          "Voice, tone, what to avoid. Free text — no formatting needed."
        }
        className="input w-full text-sm leading-relaxed"
        autoFocus
      />
      {safe.error ? (
        <p className="text-xs text-amber-700">{safe.error}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <SaveButton onSaved={() => setEditing(false)} ok={!!safe.ok} />
        <button
          type="button"
          onClick={() => {
            setDraft(props.initialValue ?? "");
            setEditing(false);
          }}
          className="btn-ghost text-xs"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SaveButton({
  onSaved,
  ok,
}: {
  onSaved: () => void;
  ok: boolean;
}) {
  const { pending } = useFormStatus();
  // Close the editor on the first render after a successful save.
  if (ok && !pending) {
    queueMicrotask(onSaved);
  }
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}
