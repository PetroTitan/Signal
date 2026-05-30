import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "../_form";
import { SupabaseConfigNotice } from "../_config-notice";

export const metadata: Metadata = { title: "Sign in" };

interface LoginPageProps {
  searchParams?: {
    next?: string;
    password_updated?: string;
    error?: string;
  };
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  const next = searchParams?.next;
  const passwordUpdated = searchParams?.password_updated === "1";
  const errorMessage = mapLoginError(searchParams?.error);
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-ink-50/40">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Link href="/" className="text-sm font-semibold text-ink-900">
            Signal
          </Link>
          <div className="text-xs text-ink-500 mt-1">
            Calm operational growth infrastructure.
          </div>
        </div>
        <SupabaseConfigNotice />
        {passwordUpdated ? (
          <div
            role="status"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
          >
            Password updated. You can now sign in with your new password.
          </div>
        ) : null}
        {errorMessage ? (
          <div
            role="alert"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800 space-y-1"
          >
            <div>{errorMessage}</div>
            {searchParams?.error === "recovery_link_invalid" ? (
              <div>
                <Link
                  href="/forgot-password"
                  className="text-signal-700 underline"
                >
                  Request a new recovery link →
                </Link>
              </div>
            ) : null}
          </div>
        ) : null}
        <AuthForm mode="signin" next={next} />
        <div className="text-xs text-center">
          <Link
            href="/forgot-password"
            className="text-signal-700 underline"
          >
            Forgot your password?
          </Link>
        </div>
      </div>
    </main>
  );
}

function mapLoginError(code: string | undefined): string | null {
  switch (code) {
    case "recovery_link_invalid":
      return "This recovery link is expired or invalid. Request a new password recovery email.";
    case "callback_failed":
      return "Sign-in could not be completed. Please try again.";
    case undefined:
    case "":
      return null;
    default:
      return null;
  }
}
