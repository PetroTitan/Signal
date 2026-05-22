"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  approveAccountReviewAction,
  archiveAccountReviewAction,
  rejectAccountReviewAction,
  type ApprovalActionState,
} from "./_actions";

const initial: ApprovalActionState = { ok: false, error: null };

export interface PendingAccountRowProps {
  accountId: string;
  displayName: string | null;
  handle: string | null;
  platform: string;
  role: string | null;
  productName: string | null;
  source: string;
  reviewStatus: string;
  connectionStatus: string;
  status: string;
  createdAt: string;
}

export function PendingAccountRow(props: PendingAccountRowProps) {
  return (
    <li className="px-5 py-4 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 truncate">
            {props.displayName ?? props.handle ?? "(unnamed account)"}
          </div>
          <div className="text-[11px] text-ink-500 mt-0.5">
            account · {props.platform}
            {props.handle ? ` · ${props.handle}` : ""}
            {props.role ? ` · role ${props.role}` : ""}
            {props.productName ? ` · product ${props.productName}` : ""}
            {" · source "}
            {props.source}
          </div>
          <div className="text-[11px] text-ink-500">
            review {props.reviewStatus} · connection {props.connectionStatus}
          </div>
          <div className="text-[11px] text-ink-400 mt-1">
            created {props.createdAt.slice(0, 19).replace("T", " ")}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-ink-500 leading-relaxed">
        Approving an account only confirms the profile inside Signal. It does
        not connect OAuth, publish, comment, or execute anything.
      </p>
      <div className="flex flex-wrap gap-2">
        <ApproveForm accountId={props.accountId} />
        <RejectForm accountId={props.accountId} />
        <ArchiveForm accountId={props.accountId} />
        <Link href="/accounts" className="btn-ghost text-xs">
          View accounts
        </Link>
      </div>
    </li>
  );
}

function ApproveForm({ accountId }: { accountId: string }) {
  const [state, action] = useFormState(approveAccountReviewAction, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="account_id" value={accountId} />
      <SubmitButton variant="primary" label="Approve account" />
      {state && !state.ok && state.error ? (
        <span className="text-[11px] text-red-700">{state.error}</span>
      ) : null}
    </form>
  );
}

function RejectForm({ accountId }: { accountId: string }) {
  const [, action] = useFormState(rejectAccountReviewAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="account_id" value={accountId} />
      <SubmitButton variant="ghost" label="Reject" />
    </form>
  );
}

function ArchiveForm({ accountId }: { accountId: string }) {
  const [, action] = useFormState(archiveAccountReviewAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="account_id" value={accountId} />
      <SubmitButton variant="ghost" label="Archive" />
    </form>
  );
}

function SubmitButton({
  variant,
  label,
}: {
  variant: "primary" | "ghost";
  label: string;
}) {
  const { pending } = useFormStatus();
  const className = variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${className} text-xs disabled:opacity-60`}
    >
      {pending ? "…" : label}
    </button>
  );
}
