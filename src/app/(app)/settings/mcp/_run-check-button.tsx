"use client";

import { useFormState, useFormStatus } from "react-dom";
import { runMcpCheckAction, type RunCheckResult } from "./_actions";

const initial: RunCheckResult = { ok: false, error: "" };

export function RunCheckButton({
  operationType,
  wired,
}: {
  operationType: string | null;
  wired: boolean;
}) {
  const [state, formAction] = useFormState(runMcpCheckAction, initial);
  const safe = state ?? initial;

  if (!wired || !operationType) {
    return (
      <button
        type="button"
        disabled
        className="btn-secondary text-xs opacity-60 cursor-not-allowed"
        title="Check is prepared but not connected yet."
      >
        Prepared, not connected
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input type="hidden" name="operation_type" value={operationType} />
        <Submit />
      </div>
      {safe.ok ? (
        <p
          className={`text-[11px] ${safe.checkOk ? "text-green-700" : "text-red-700"}`}
        >
          {safe.checkOk ? "Completed." : "Check failed."}{" "}
          {safe.notes.length > 0 ? safe.notes.join(" ") : null}
        </p>
      ) : safe.error ? (
        <p className="text-[11px] text-red-700">{safe.error}</p>
      ) : null}
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-xs" disabled={pending}>
      {pending ? "Running…" : "Run check"}
    </button>
  );
}
