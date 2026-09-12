import type { Metadata } from "next";
import Link from "next/link";
import { SignalLogo } from "@/components/brand/signal-logo";
import { AuthForm } from "../_form";
import { SupabaseConfigNotice } from "../_config-notice";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-ink-50/40">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          {/* The full lockup: on an auth page the logo is the only
              thing identifying the product, so it carries the name
              rather than decorating one. The link's accessible name
              comes from the lockup's own text — no second label. */}
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md focus:outline-none focus:ring-2 focus:ring-signal-500 focus:ring-offset-2"
          >
            <SignalLogo variant="lockup" size={26} />
          </Link>
          <div className="text-xs text-ink-500 mt-1">
            Configure once. Reuse context. Approve weekly.
          </div>
        </div>
        <SupabaseConfigNotice />
        <AuthForm mode="signup" />
      </div>
    </main>
  );
}
