"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  submitOperatorBridgeResultAction,
  type SubmitResult,
} from "./_actions";

const initial: SubmitResult = { ok: false, error: "" };

export function SubmitResultForm({ requestId }: { requestId: string }) {
  const [state, formAction] = useFormState(
    submitOperatorBridgeResultAction,
    initial,
  );
  const safe = state ?? initial;
  return (
    <form action={formAction} className="space-y-3 mt-3">
      <input type="hidden" name="request_id" value={requestId} />
      <textarea
        name="result_json"
        rows={10}
        className="input w-full font-mono text-xs"
        placeholder='Paste the result envelope JSON — exactly what the assistant returned. No prose, no code fences.'
        required
      />
      <div className="flex items-center gap-3">
        <Submit />
        {safe.ok ? (
          <span
            className={`text-[11px] ${
              safe.verificationStatus === "verified"
                ? "text-green-700"
                : "text-red-700"
            }`}
          >
            verification: {safe.verificationStatus}
            {safe.errors.length > 0 ? ` (${safe.errors.slice(0, 3).join(", ")})` : null}
          </span>
        ) : safe.error ? (
          <span className="text-[11px] text-red-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-xs" disabled={pending}>
      {pending ? "Verifying…" : "Submit result"}
    </button>
  );
}
