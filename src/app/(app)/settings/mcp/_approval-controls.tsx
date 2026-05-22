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

export function ApproveButton({
  runId,
  approvalMode,
}: {
  runId: string;
  approvalMode?: string;
}) {
  const [state, formAction] = useFormState(
    approveMcpOperationAction,
    approveInitial,
  );
  const safe = state ?? approveInitial;
  const requiresPhrase = approvalMode === "explicit_text_confirmation_required";
  const expected = `approve production operation ${runId}`;
  return (
    <form action={formAction} className="inline-flex items-center gap-2 flex-wrap">
      <input type="hidden" name="run_id" value={runId} />
      {requiresPhrase ? (
        <input
          type="text"
          name="confirmation_phrase"
          placeholder={expected}
          className="input text-xs min-w-[20rem]"
          autoComplete="off"
        />
      ) : null}
      <SubmitBtn label={requiresPhrase ? "Approve (production)" : "Approve"} />
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
