"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  activateContractAction,
  approveContractAction,
  pauseContractAction,
  resumeContractAction,
  revokeContractAction,
  submitContractAction,
  type LifecycleActionResult,
} from "./_actions";
import type { WeeklyContractStatus } from "@/core/weekly-contract";

const initial: LifecycleActionResult = { ok: false, error: "" };

interface ControlsProps {
  contractId: string;
  status: WeeklyContractStatus;
  expectedPhrase: string;
}

export function ContractLifecycleControls({
  contractId,
  status,
  expectedPhrase,
}: ControlsProps) {
  return (
    <section className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">Lifecycle</h2>

      {status === "draft" ? (
        <Submit
          action={submitContractAction}
          contractId={contractId}
          label="Submit for approval"
        />
      ) : null}

      {status === "pending_approval" ? (
        <ApprovalForm
          contractId={contractId}
          expectedPhrase={expectedPhrase}
        />
      ) : null}

      {status === "approved" ? (
        <Submit
          action={activateContractAction}
          contractId={contractId}
          label="Activate"
          danger
        />
      ) : null}

      {status === "active" ? (
        <PauseForm contractId={contractId} />
      ) : null}

      {status === "paused" ? (
        <Submit
          action={resumeContractAction}
          contractId={contractId}
          label="Resume"
        />
      ) : null}

      {status !== "revoked" && status !== "expired" ? (
        <RevokeForm contractId={contractId} />
      ) : null}

      {status === "revoked" || status === "expired" ? (
        <p className="text-xs text-ink-500">
          This contract is closed and cannot authorize further execution.
        </p>
      ) : null}
    </section>
  );
}

function Submit({
  action,
  contractId,
  label,
  danger,
}: {
  action: (
    prev: LifecycleActionResult,
    fd: FormData,
  ) => Promise<LifecycleActionResult>;
  contractId: string;
  label: string;
  danger?: boolean;
}) {
  const [state, formAction] = useFormState(action, initial);
  const safe = state ?? initial;
  return (
    <form action={formAction} className="flex items-center gap-3">
      <input type="hidden" name="contract_id" value={contractId} />
      <SubmitButton label={label} danger={danger} />
      {!safe.ok && safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function ApprovalForm({
  contractId,
  expectedPhrase,
}: {
  contractId: string;
  expectedPhrase: string;
}) {
  const [state, formAction] = useFormState(approveContractAction, initial);
  const safe = state ?? initial;
  return (
    <form action={formAction} className="space-y-2">
      <p className="text-xs text-ink-600">
        Type{" "}
        <code className="font-mono text-[11px] bg-ink-100 px-1 rounded">
          {expectedPhrase}
        </code>{" "}
        to approve.
      </p>
      <input type="hidden" name="contract_id" value={contractId} />
      <input type="hidden" name="expected_phrase" value={expectedPhrase} />
      <input
        type="text"
        name="approval_phrase"
        autoComplete="off"
        className="input w-full text-sm"
        placeholder={expectedPhrase}
        required
      />
      <SubmitButton label="Approve" />
      {!safe.ok && safe.error ? (
        <p className="text-xs text-red-700">{safe.error}</p>
      ) : null}
    </form>
  );
}

function PauseForm({ contractId }: { contractId: string }) {
  const [state, formAction] = useFormState(pauseContractAction, initial);
  const safe = state ?? initial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="contract_id" value={contractId} />
      <input
        type="text"
        name="reason"
        placeholder="Pause reason (optional)"
        className="input text-xs flex-1"
      />
      <SubmitButton label="Pause" danger />
      {!safe.ok && safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function RevokeForm({ contractId }: { contractId: string }) {
  const [state, formAction] = useFormState(revokeContractAction, initial);
  const safe = state ?? initial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="contract_id" value={contractId} />
      <input
        type="text"
        name="reason"
        placeholder="Revoke reason (optional)"
        className="input text-xs flex-1"
      />
      <SubmitButton label="Revoke" danger />
      {!safe.ok && safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const className = danger ? "btn-secondary text-xs" : "btn-primary text-xs";
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : label}
    </button>
  );
}
