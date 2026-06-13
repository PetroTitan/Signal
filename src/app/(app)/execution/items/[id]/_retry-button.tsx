"use client";

import { useFormState, useFormStatus } from "react-dom";
import { retryFailedExecutionItemAction } from "./_actions";
import type { ActionResult } from "@/lib/forms/action-result";

/**
 * A3/A4 — operator "Try again" for a failed scheduled publish. Requeues
 * the item for the scheduler (fresh attempt budget); it does not
 * publish inline and does not re-approve.
 */
const initial: ActionResult = { ok: false, error: "" };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary disabled:opacity-50">
      {pending ? "Requeuing…" : "Try again"}
    </button>
  );
}

export function RetryFailedButton({ executionItemId }: { executionItemId: string }) {
  const [state, formAction] = useFormState(
    retryFailedExecutionItemAction,
    initial,
  );
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="execution_item_id" value={executionItemId} />
      <SubmitButton />
      {state.ok ? (
        <p className="text-[11px] text-emerald-700">
          Requeued — the scheduler will reattempt it shortly.
        </p>
      ) : state.error ? (
        <p className="text-[11px] text-red-700">{state.error}</p>
      ) : (
        <p className="text-[11px] text-ink-500">
          Requeues this post for the scheduler. Fix the cause first if it
          wasn&apos;t a temporary error.
        </p>
      )}
    </form>
  );
}
