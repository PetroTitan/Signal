"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveProductReviewAction,
  archiveProductReviewAction,
  rejectProductReviewAction,
  type ApprovalActionState,
} from "./_actions";

const initial: ApprovalActionState = { ok: false, error: null };

export interface PendingProductRowProps {
  productId: string;
  name: string;
  domain: string | null;
  summary: string | null;
  category: string | null;
  source: string;
  reviewStatus: string;
  status: string;
  createdAt: string;
}

export function PendingProductRow(props: PendingProductRowProps) {
  return (
    <li className="px-5 py-4 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 truncate">
            {props.name}
          </div>
          <div className="text-[11px] text-ink-500 mt-0.5">
            product
            {props.category ? ` · ${props.category}` : ""}
            {props.domain ? ` · ${props.domain}` : ""}
            {" · source "}
            {props.source}
            {" · "}
            {props.reviewStatus}
          </div>
          {props.summary ? (
            <p className="text-xs text-ink-700 mt-1 line-clamp-3">
              {props.summary}
            </p>
          ) : null}
          <div className="text-[11px] text-ink-400 mt-1">
            created {props.createdAt.slice(0, 19).replace("T", " ")}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-ink-500 leading-relaxed">
        Approving a product profile only confirms it inside Signal. It does not
        connect OAuth, publish, schedule, or execute.
      </p>
      <div className="flex flex-wrap gap-2">
        <ApproveForm productId={props.productId} />
        <RejectForm productId={props.productId} />
        <ArchiveForm productId={props.productId} />
      </div>
    </li>
  );
}

function ApproveForm({ productId }: { productId: string }) {
  const [state, action] = useFormState(approveProductReviewAction, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="product_id" value={productId} />
      <SubmitButton variant="primary" label="Approve product" />
      {state && !state.ok && state.error ? (
        <span className="text-[11px] text-red-700">{state.error}</span>
      ) : null}
    </form>
  );
}

function RejectForm({ productId }: { productId: string }) {
  const [, action] = useFormState(rejectProductReviewAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="product_id" value={productId} />
      <SubmitButton variant="ghost" label="Reject" />
    </form>
  );
}

function ArchiveForm({ productId }: { productId: string }) {
  const [, action] = useFormState(archiveProductReviewAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="product_id" value={productId} />
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
