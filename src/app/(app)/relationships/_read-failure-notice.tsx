"use client";
/**
 * What the page shows when it could not read its own data.
 *
 * Three surfaces, because three causes need three different operator
 * responses. The one thing all of them share: none renders an empty
 * list. "No candidates yet" beside a failed read looks like success,
 * and an operator who believes their corpus is empty may go and import
 * it again.
 *
 * Only a genuinely temporary failure gets a Retry. Putting one under an
 * unapplied migration would invite an operator to press it forever
 * while hiding the single fact that would let them fix it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReadFailure } from "@/core/bluesky-relationships/read-failure";

export function ReadFailureNotice({ failure }: { failure: ReadFailure }) {
  const router = useRouter();

  const heading =
    failure.kind === "schema_missing"
      ? "Relationship tables are missing"
      : failure.kind === "authorization"
        ? "Could not read this workspace's relationships"
        : "Could not load relationships";

  // Amber for something an operator can act on now; red for a
  // structural fault that needs someone else.
  const tone =
    failure.kind === "temporary"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-red-200 bg-red-50 text-red-900";

  return (
    <div className="card card-padded space-y-4" role="alert">
      <div>
        <h2 className="text-base font-semibold text-ink-900">{heading}</h2>
        <p className={`text-sm mt-2 leading-relaxed border rounded-md p-3 ${tone}`}>
          {failure.message}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {failure.retryable ? (
          <button
            type="button"
            className="btn-primary"
            // router.refresh re-runs the server component with the same
            // URL — the whole page state is in the URL, so a retry
            // lands exactly where the operator was.
            onClick={() => router.refresh()}
          >
            Try again
          </button>
        ) : null}
        <Link href="/accounts" className="btn-secondary">
          Go to Accounts
        </Link>
      </div>

      {failure.kind !== "temporary" ? (
        <p className="text-sm text-ink-600 leading-relaxed">
          Nothing was changed, and no relationship on Bluesky was touched. Any
          follows or unfollows already recorded are still recorded — this page
          could not read them, which is not the same as them being gone.
        </p>
      ) : null}
    </div>
  );
}
