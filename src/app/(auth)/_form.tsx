"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { signInAction, signUpAction, type AuthActionState } from "./_actions";

const initial: AuthActionState = { ok: false, error: null };

interface AuthFormProps {
  mode: "signin" | "signup";
  next?: string;
}

export function AuthForm({ mode, next }: AuthFormProps) {
  const action = mode === "signin" ? signInAction : signUpAction;
  const [state, formAction] = useFormState(action, initial);
  const title = mode === "signin" ? "Sign in" : "Create your account";
  const cta = mode === "signin" ? "Sign in" : "Create account";
  const altLabel = mode === "signin" ? "Need an account?" : "Already have one?";
  const altHref = mode === "signin" ? "/signup" : "/login";
  const altText = mode === "signin" ? "Sign up" : "Sign in";

  return (
    <div className="card p-6 max-w-md w-full space-y-5">
      <div>
        <h1 className="text-base font-semibold text-ink-900">{title}</h1>
        <p className="text-xs text-ink-500 mt-1 leading-relaxed">
          Email and password only. No social logins, no magic links.
        </p>
      </div>

      <form action={formAction} className="space-y-3">
        {next ? <input type="hidden" name="next" value={next} /> : null}
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
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Password
          </div>
          <input
            type="password"
            name="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? 8 : undefined}
            className="input w-full font-mono text-xs"
          />
          {mode === "signup" ? (
            <div className="text-[11px] text-ink-500 mt-1">
              At least 8 characters.
            </div>
          ) : null}
        </label>

        {state.error ? (
          <div
            role="alert"
            className={`text-xs leading-relaxed rounded-md px-3 py-2 ${
              state.ok
                ? "bg-emerald-50 text-emerald-800"
                : "bg-amber-50 text-amber-800"
            }`}
          >
            {state.error}
          </div>
        ) : null}

        <SubmitButton label={cta} />
      </form>

      <div className="text-xs text-ink-500 text-center">
        {altLabel}{" "}
        <Link href={altHref} className="text-signal-700 underline">
          {altText}
        </Link>
      </div>
    </div>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary w-full disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}
