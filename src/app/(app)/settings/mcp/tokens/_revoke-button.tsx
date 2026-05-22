"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  revokeOperatorTokenAction,
  type RevokeTokenResult,
} from "./_actions";

const initial: RevokeTokenResult = { ok: false, error: "" };

export function RevokeTokenButton({ tokenId }: { tokenId: string }) {
  const [state, formAction] = useFormState(revokeOperatorTokenAction, initial);
  const safe = state ?? initial;
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="token_id" value={tokenId} />
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
    <button type="submit" className="btn-secondary text-[11px]" disabled={pending}>
      {pending ? "…" : "Revoke"}
    </button>
  );
}
