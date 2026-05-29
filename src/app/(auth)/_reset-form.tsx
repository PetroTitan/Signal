"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  updatePasswordAction,
  type UpdatePasswordActionState,
} from "./_actions";

const initial: UpdatePasswordActionState = { ok: false, error: null };

export function ResetPasswordForm() {
  const [state, formAction] = useFormState(updatePasswordAction, initial);

  return (
    <div className="card p-6 max-w-md w-full space-y-5">
      <div>
        <h1 className="text-base font-semibold text-ink-900">
          Set a new password
        </h1>
        <p className="text-xs text-ink-500 mt-1 leading-relaxed">
          Enter a new password for your Signal account.
        </p>
      </div>

      <form action={formAction} className="space-y-3">
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            New password
          </div>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={8}
            className="input w-full font-mono text-xs"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            At least 8 characters.
          </div>
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Confirm new password
          </div>
          <input
            type="password"
            name="confirm"
            autoComplete="new-password"
            required
            minLength={8}
            className="input w-full font-mono text-xs"
          />
        </label>

        {state.error ? (
          <div
            role="alert"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
          >
            {state.error}
          </div>
        ) : null}

        <SubmitButton />
      </form>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary w-full disabled:opacity-60"
    >
      {pending ? "Updating…" : "Update password"}
    </button>
  );
}
