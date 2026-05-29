import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "../_reset-form";
import { SupabaseConfigNotice } from "../_config-notice";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase";

export const metadata: Metadata = { title: "Set a new password" };
export const dynamic = "force-dynamic";

/**
 * /reset-password — only reachable with an active recovery session.
 *
 * The user lands here after clicking the recovery link in their email,
 * which routes through /auth/callback?type=recovery and establishes a
 * short-lived Supabase session via `exchangeCodeForSession`. If they
 * navigate here without a session (link expired, opened the URL by
 * hand, clicked the link twice), we render a clear "expired or invalid"
 * panel pointing back at /forgot-password.
 *
 * This page is intentionally NOT in the middleware's public path set —
 * the middleware enforces the session-required gate. We re-check the
 * user here so we can render the "expired" panel instead of bouncing
 * to /login (which would lose the context that they were trying to
 * recover their password).
 */
export default async function ResetPasswordPage() {
  if (!isSupabaseConfigured()) {
    return (
      <Shell>
        <SupabaseConfigNotice />
      </Shell>
    );
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Shell>
        <div className="card p-6 max-w-md w-full space-y-3">
          <h1 className="text-base font-semibold text-ink-900">
            Recovery link expired
          </h1>
          <p className="text-xs text-ink-600 leading-relaxed">
            This recovery link is expired or invalid. Request a new password
            recovery email to continue.
          </p>
          <div className="pt-2">
            <Link
              href="/forgot-password"
              className="btn-primary inline-flex justify-center w-full"
            >
              Request a new recovery link
            </Link>
          </div>
          <div className="text-xs text-ink-500 text-center pt-1">
            Or{" "}
            <Link href="/login" className="text-signal-700 underline">
              sign in
            </Link>{" "}
            if you remembered your password.
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <ResetPasswordForm />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </main>
  );
}
