"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveAndHoldAction,
  approveWeeklyPlanAction,
  type ApproveAndHoldResult,
  type ApproveWeeklyPlanResult,
} from "./_actions";

const initialApprove: ApproveWeeklyPlanResult = { ok: false, error: "" };
const initialHold: ApproveAndHoldResult = { ok: false, error: "" };

interface ApprovePlanFormProps {
  planId: string;
  pendingCount: number;
}

export function ApprovePlanForm({ planId, pendingCount }: ApprovePlanFormProps) {
  const [approveState, approveAction] = useFormState(
    approveWeeklyPlanAction,
    initialApprove,
  );
  const [holdState, holdActionFn] = useFormState(
    approveAndHoldAction,
    initialHold,
  );
  const safeApprove = approveState ?? initialApprove;
  const safeHold = holdState ?? initialHold;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">
        Bulk approve pending posts
      </h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Two bulk ways to approve {pendingCount} pending post
        {pendingCount === 1 ? "" : "s"} at once. Bulk approval requires
        an active weekly contract. Individual posts can still be
        approved &amp; held without one — use the buttons on each card.
      </p>
      <ul className="text-xs text-ink-600 leading-relaxed mt-2 space-y-1 list-disc pl-4">
        <li>
          <strong>Approve weekly plan</strong> — Signal schedules every post
          at the time you picked. The scheduler publishes them later.
        </li>
        <li>
          <strong>Approve &amp; hold</strong> — items are marked approved but
          NOT scheduled. Useful when Claude (via Signal MCP) will pick the
          publish time after the approval.
        </li>
      </ul>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <form action={approveAction} className="space-y-2">
          <input type="hidden" name="plan_id" value={planId} />
          <ApproveButton />
          {safeApprove.ok ? (
            <div
              role="status"
              className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 space-y-1"
            >
              <div>
                Approved {safeApprove.itemsApproved} post
                {safeApprove.itemsApproved === 1 ? "" : "s"}.{" "}
                {safeApprove.executionItemsCreated}{" "}
                {safeApprove.executionItemsCreated === 1 ? "is" : "are"} queued
                for publishing.
              </div>
              {safeApprove.warnings.length > 0 ? (
                <ul className="list-disc list-inside text-amber-800 mt-1">
                  {safeApprove.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : safeApprove.error ? (
            <div
              role="alert"
              className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
            >
              {safeApprove.error}
            </div>
          ) : null}
        </form>

        <form action={holdActionFn} className="space-y-2">
          <input type="hidden" name="plan_id" value={planId} />
          <HoldButton />
          {safeHold.ok ? (
            <div
              role="status"
              data-testid="approve-and-hold-result"
              className="text-xs leading-relaxed rounded-md px-3 py-2 bg-signal-50 text-signal-800 space-y-1"
            >
              <div>
                Approved. Waiting for scheduling. {safeHold.itemsApproved} item
                {safeHold.itemsApproved === 1 ? "" : "s"} held for an operator
                or MCP scheduler to set a publish time.
              </div>
              {safeHold.warnings.length > 0 ? (
                <ul className="list-disc list-inside text-amber-800 mt-1">
                  {safeHold.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : safeHold.error ? (
            <div
              role="alert"
              className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
            >
              {safeHold.error}
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}

function ApproveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary disabled:opacity-60 w-full"
    >
      {pending ? "Approving…" : "Approve weekly plan"}
    </button>
  );
}

function HoldButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-secondary disabled:opacity-60 w-full"
    >
      {pending ? "Approving…" : "Approve & hold for scheduling"}
    </button>
  );
}
