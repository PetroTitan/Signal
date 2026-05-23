"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveWeeklyPlanAction,
  type ApproveWeeklyPlanResult,
} from "./_actions";

const initial: ApproveWeeklyPlanResult = { ok: false, error: "" };

interface ApprovePlanFormProps {
  planId: string;
  pendingCount: number;
}

export function ApprovePlanForm({ planId, pendingCount }: ApprovePlanFormProps) {
  const [state, formAction] = useFormState(approveWeeklyPlanAction, initial);
  const safe = state ?? initial;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">
        Approve this week
      </h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Approves all {pendingCount} pending post
        {pendingCount === 1 ? "" : "s"} for this week. Each post goes out at
        the time you scheduled it — Signal won&apos;t publish anything before
        then, and never outside the active publishing scope.
      </p>
      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="plan_id" value={planId} />
        <SubmitButton />

        {safe.ok ? (
          <div
            role="status"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 space-y-1"
          >
            <div>
              Approved {safe.itemsApproved} post
              {safe.itemsApproved === 1 ? "" : "s"}. {safe.executionItemsCreated}{" "}
              {safe.executionItemsCreated === 1 ? "is" : "are"} queued for
              publishing.
            </div>
            {safe.warnings.length > 0 ? (
              <ul className="list-disc list-inside text-amber-800 mt-1">
                {safe.warnings.map((w: string, i: number) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : safe.error ? (
          <div
            role="alert"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
          >
            {safe.error}
          </div>
        ) : null}
      </form>
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary disabled:opacity-60"
    >
      {pending ? "Approving…" : "Approve weekly plan"}
    </button>
  );
}
