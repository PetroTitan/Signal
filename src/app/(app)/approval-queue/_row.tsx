"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveItemAction,
  moveToBacklogAction,
  rejectItemAction,
  type ApprovalActionState,
} from "./_actions";

const initial: ApprovalActionState = { ok: false, error: null };

interface ApprovalRowProps {
  itemId: string;
  title: string | null;
  platform: string | null;
  contentType: string | null;
  body: string | null;
  riskLevel: string | null;
}

export function ApprovalRow({
  itemId,
  title,
  platform,
  contentType,
  body,
  riskLevel,
}: ApprovalRowProps) {
  return (
    <li className="px-5 py-4 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900">
            {title ?? "Untitled"}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            {platform ?? "—"}
            {contentType ? ` · ${contentType}` : ""}
            {riskLevel ? ` · risk ${riskLevel}` : ""}
          </div>
          {body ? (
            <p className="text-xs text-ink-700 mt-1 line-clamp-3">{body}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <ApproveForm itemId={itemId} />
        <RejectForm itemId={itemId} />
        <BacklogForm itemId={itemId} />
      </div>
    </li>
  );
}

function ApproveForm({ itemId }: { itemId: string }) {
  const [, action] = useFormState(approveItemAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="item_id" value={itemId} />
      <SubmitButton variant="primary" label="Approve" />
    </form>
  );
}

function RejectForm({ itemId }: { itemId: string }) {
  const [, action] = useFormState(rejectItemAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="item_id" value={itemId} />
      <SubmitButton variant="ghost" label="Reject" />
    </form>
  );
}

function BacklogForm({ itemId }: { itemId: string }) {
  const [, action] = useFormState(moveToBacklogAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="item_id" value={itemId} />
      <SubmitButton variant="ghost" label="Move to backlog" />
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
  const className =
    variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button type="submit" disabled={pending} className={`${className} disabled:opacity-60`}>
      {pending ? "…" : label}
    </button>
  );
}
