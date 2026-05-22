"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { prepareImportAction, type PrepareImportResult } from "./_actions";

const initial: PrepareImportResult = { ok: false, error: "" };

export function PrepareImportForm({
  kind,
  label,
  placeholder,
}: {
  kind: "product" | "account";
  label: string;
  placeholder: string;
}) {
  const [state, formAction] = useFormState(prepareImportAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      // Don't clear the textarea — the operator may need it to drive
      // the assistant outside Signal. Just acknowledge.
    }
  }, [state]);

  const safe = state ?? initial;

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="kind" value={kind} />
      <label className="block">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          {label}
        </div>
        <textarea
          name="source_text"
          rows={5}
          className="input w-full font-mono text-xs"
          placeholder={placeholder}
          required
        />
      </label>
      <div className="flex items-center gap-3">
        <Submit />
        {safe.ok ? (
          <div className="text-[11px] text-ink-600">
            Operation <code className="font-mono">{safe.runId.slice(0, 8)}</code>{" "}
            recorded with status <span className="font-mono">{safe.status}</span>.{" "}
            {safe.message}
          </div>
        ) : safe.error ? (
          <span className="text-[11px] text-red-700">{safe.error}</span>
        ) : null}
      </div>
      <p className="text-[10px] text-ink-500 leading-relaxed">
        Source text is sent to the server only to record an operation run.
        No screenshots are stored. No fields are auto-saved to products or
        accounts — confirm in the next step.
      </p>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-xs" disabled={pending}>
      {pending ? "Recording…" : "Prepare extraction"}
    </button>
  );
}
