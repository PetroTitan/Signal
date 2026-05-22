"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  cancelOperatorBridgeRequestAction,
  type CancelResult,
} from "./_actions";

const initial: CancelResult = { ok: false, error: "" };

export function CancelRequestForm({ requestId }: { requestId: string }) {
  const [state, formAction] = useFormState(
    cancelOperatorBridgeRequestAction,
    initial,
  );
  const safe = state ?? initial;
  return (
    <form action={formAction} className="card p-5 flex items-center gap-3">
      <input type="hidden" name="request_id" value={requestId} />
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold text-ink-900">Cancel request</h2>
        <p className="text-xs text-ink-600 mt-1">
          Marks the request <code className="font-mono text-[11px]">cancelled</code>.
          The active nonce will not be reusable.
        </p>
      </div>
      <Submit />
      {!safe.ok && safe.error ? (
        <span className="text-[11px] text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-secondary text-xs" disabled={pending}>
      {pending ? "…" : "Cancel"}
    </button>
  );
}
