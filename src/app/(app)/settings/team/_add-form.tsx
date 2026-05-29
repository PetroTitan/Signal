"use client";

import { useFormState, useFormStatus } from "react-dom";
import { addMemberAction, type AddMemberOutcome } from "./_actions";

const initial: AddMemberOutcome | null = null;

export function AddTeamMemberForm() {
  const [state, formAction] = useFormState(addMemberAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <label className="block">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Worker email
        </div>
        <input
          type="email"
          name="email"
          autoComplete="off"
          required
          placeholder="worker@example.com"
          className="input w-full font-mono text-xs"
        />
      </label>
      <SubmitButton />
      {state ? <FormOutcomeBanner outcome={state} /> : null}
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add to this workspace"}
    </button>
  );
}

function FormOutcomeBanner({ outcome }: { outcome: AddMemberOutcome }) {
  switch (outcome.kind) {
    case "ok":
      return (
        <div
          role="status"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
        >
          Added <span className="font-mono">{outcome.addedEmail}</span> to this
          workspace.
        </div>
      );
    case "missing_email":
      return (
        <div
          role="alert"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
        >
          Enter the worker&apos;s email.
        </div>
      );
    case "must_sign_up":
      return (
        <div
          role="alert"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
        >
          User must first create a Signal account at{" "}
          <span className="font-mono">/signup</span>, then you can add them
          here.
        </div>
      );
    case "already_member":
      return (
        <div
          role="status"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-ink-50 text-ink-700"
        >
          <span className="font-mono">{outcome.email}</span> is already a
          member of this workspace.
        </div>
      );
    case "permission_denied":
      return (
        <div
          role="alert"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
        >
          Only the workspace owner can add members.
        </div>
      );
    case "no_workspace":
      return (
        <div
          role="alert"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
        >
          No workspace found. Refresh the page and try again.
        </div>
      );
    case "error":
    default:
      return (
        <div
          role="alert"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
        >
          {outcome.kind === "error"
            ? outcome.message
            : "Something went wrong."}
        </div>
      );
  }
}
