"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  archiveAccountAction,
  type ArchiveAccountResult,
} from "./_actions";

const initial: ArchiveAccountResult = { ok: false, error: "" };

export function ArchiveAccountButton({ accountId }: { accountId: string }) {
  const [, action] = useFormState(archiveAccountAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="account_id" value={accountId} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-ghost text-xs disabled:opacity-60"
    >
      {pending ? "Archiving…" : "Archive"}
    </button>
  );
}
