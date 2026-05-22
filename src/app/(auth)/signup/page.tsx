import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "../_form";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-ink-50/40">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Link href="/" className="text-sm font-semibold text-ink-900">
            Signal
          </Link>
          <div className="text-xs text-ink-500 mt-1">
            Configure once. Reuse context. Approve weekly.
          </div>
        </div>
        <AuthForm mode="signup" />
      </div>
    </main>
  );
}
