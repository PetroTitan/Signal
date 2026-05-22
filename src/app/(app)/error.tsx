"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary for the authenticated app. Catches any
 * uncaught throw inside (app)/* server components — bootstrap failures,
 * repository errors, missing data on a deep page — and renders a calm
 * recovery surface instead of the Next.js default crash page.
 *
 * Logs the error server-side (it's already on the server) for the
 * operator to read in Vercel logs. The `digest` is shown to the user
 * so they can quote it in a bug report.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error] uncaught", error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-ink-50/40">
      <div className="card max-w-md w-full p-6 space-y-4">
        <div>
          <h1 className="text-base font-semibold text-ink-900">
            Something went wrong
          </h1>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            The page hit an unexpected error. Try again, or sign out and
            sign back in. No data is lost.
          </p>
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-ink-700">
          <div className="font-medium text-ink-900 mb-1">Detail</div>
          <div className="leading-relaxed break-words">
            {error.message || "Unknown error."}
          </div>
          {error.digest ? (
            <div className="mt-1 font-mono text-[11px] text-ink-500">
              digest: {error.digest}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => reset()} className="btn-primary">
            Try again
          </button>
          <Link href="/login" className="btn">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
