"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveMcpOperationAction,
  rejectMcpOperationAction,
  type ApproveResult,
  type RejectResult,
} from "./_actions";

const approveInitial: ApproveResult = { ok: false, error: "" };
const rejectInitial: RejectResult = { ok: false, error: "" };

export function ApproveButton({ runId }: { runId: string }) {
  const [state, formAction] = useFormState(
    approveMcpOperationAction,
    approveInitial,
  );
  const safe = state ?? approveInitial;
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="run_id" value={runId} />
      <SubmitBtn label="Approve" />
      {!safe.ok && safe.error ? (
        <span className="text-[11px] text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

export function RejectForm({ runId }: { runId: string }) {
  const [state, formAction] = useFormState(
    rejectMcpOperationAction,
    rejectInitial,
  );
  const safe = state ?? rejectInitial;
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="run_id" value={runId} />
      <input
        type="text"
        name="reason"
        placeholder="Reason (optional)"
        className="input text-xs"
      />
      <SubmitBtn label="Reject" danger />
      {!safe.ok && safe.error ? (
        <span className="text-[11px] text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function SubmitBtn({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const className = danger ? "btn-secondary text-xs" : "btn-primary text-xs";
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : label}
    </button>
  );
}
