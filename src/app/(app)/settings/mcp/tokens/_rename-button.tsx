"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  renameOperatorTokenAction,
  type RenameTokenResult,
} from "./_actions";

interface RenameTokenButtonProps {
  tokenId: string;
  initialName: string;
}

const initial: RenameTokenResult = { ok: false, error: "" };

export function RenameTokenButton(props: RenameTokenButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(props.initialName);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setName(props.initialName);
          setError(null);
          setOpen(true);
        }}
        className="text-[11px] text-ink-600 hover:text-ink-900 underline"
      >
        Rename
      </button>
    );
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    const result = await renameOperatorTokenAction(initial, formData);
    if (result.ok) {
      setOpen(false);
    } else {
      setError(result.error || "Could not rename token.");
    }
  }

  return (
    <form action={handleSubmit} className="inline-flex items-center gap-1.5">
      <input type="hidden" name="token_id" value={props.tokenId} />
      <input
        type="text"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={200}
        autoFocus
        className="input text-[11px] py-0.5 px-1.5 min-w-[10rem]"
      />
      <SaveButton />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-[11px] text-ink-500 hover:text-ink-700 underline"
      >
        Cancel
      </button>
      {error ? (
        <span className="text-[10px] text-amber-700">{error}</span>
      ) : null}
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-[11px] text-signal-700 hover:text-signal-800 underline disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}
