"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  requestPasswordRecoveryAction,
  type RequestRecoveryActionState,
} from "./_actions";

const initial: RequestRecoveryActionState = { ok: false, error: null };

export function ForgotPasswordForm() {
  const [state, formAction] = useFormState(
    requestPasswordRecoveryAction,
    initial,
  );

  return (
    <div className="card p-6 max-w-md w-full space-y-5">
      <div>
        <h1 className="text-base font-semibold text-ink-900">
          Reset your password
        </h1>
        <p className="text-xs text-ink-500 mt-1 leading-relaxed">
          Enter the email you signed up with. We&apos;ll send a one-time link
          to set a new password.
        </p>
      </div>

      {state.ok ? (
        <div
          role="status"
          className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
        >
          If an account exists for that email, a password recovery link is on
          its way. Check your inbox (and spam folder) to continue.
        </div>
      ) : (
        <form action={formAction} className="space-y-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Email
            </div>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
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
      )}

      <div className="text-xs text-ink-500 text-center">
        Remembered it?{" "}
        <Link href="/login" className="text-signal-700 underline">
          Sign in
        </Link>
      </div>
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
      {pending ? "Sending…" : "Send recovery link"}
    </button>
  );
}
