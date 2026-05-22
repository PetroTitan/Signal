"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  archiveProductAction,
  type ArchiveProductResult,
} from "./_actions";

const initial: ArchiveProductResult = { ok: false, error: "" };

export function ArchiveProductButton({ productId }: { productId: string }) {
  const [, action] = useFormState(archiveProductAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="product_id" value={productId} />
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
