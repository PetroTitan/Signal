"use client";

import { useFormState, useFormStatus } from "react-dom";
import { refreshResultMetricsAction } from "./_actions";
import type { ActionResult } from "@/lib/forms/action-result";

const initial: ActionResult = { ok: false, error: "" };

function Btn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-[11px] text-signal-700 hover:text-signal-800 disabled:opacity-50"
    >
      {pending ? "Refreshing…" : "Refresh metrics"}
    </button>
  );
}

/** C3.6 — manual metrics refresh for verified-capable platforms. */
export function MetricsRefreshButton({ publishHistoryId }: { publishHistoryId: string }) {
  const [state, action] = useFormState(refreshResultMetricsAction, initial);
  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="publish_history_id" value={publishHistoryId} />
      <Btn />
      {state.error ? <span className="text-[10px] text-red-600">{state.error}</span> : null}
    </form>
  );
}
