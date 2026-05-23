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
  scheduledAt: string | null;
  accountLabel: string | null;
  productName: string | null;
  creative: {
    type: string;
    sourceType: string;
    status: string;
    assetUrl: string | null;
  } | null;
  warnings: string[];
  isPost: boolean;
  canApprove: boolean;
}

export function ApprovalRow({
  itemId,
  title,
  platform,
  contentType,
  body,
  riskLevel,
  scheduledAt,
  accountLabel,
  productName,
  creative,
  warnings,
  isPost,
  canApprove,
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
            {accountLabel ? ` · ${accountLabel}` : ""}
            {productName ? ` · ${productName}` : ""}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            {scheduledAt
              ? `Scheduled ${new Date(scheduledAt).toLocaleString()}`
              : "No schedule"}
            {" · "}
            {creative
              ? `Creative: ${creative.type} (${creative.sourceType}, ${creative.status})`
              : isPost
                ? "Creative: missing"
                : "Creative: n/a"}
          </div>
          {creative?.assetUrl ? (
            <div className="mt-2">
              {creative.type === "video" ||
              /\.(mp4|webm)(\?|$)/i.test(creative.assetUrl) ? (
                <video
                  src={creative.assetUrl}
                  muted
                  controls
                  className="max-h-32 rounded-md border border-ink-200"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={creative.assetUrl}
                  alt="creative thumbnail"
                  className="max-h-32 rounded-md border border-ink-200 object-contain"
                />
              )}
            </div>
          ) : null}
          {body ? (
            <p className="text-xs text-ink-700 mt-1 line-clamp-3">{body}</p>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="text-[11px] text-amber-700 leading-relaxed mt-2 space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>· {w}</li>
              ))}
            </ul>
          ) : null}
          {!isPost ? (
            <p className="text-[11px] text-ink-500 mt-2 italic">
              Comments are draft-only in this version — approving keeps it
              as a draft and does not enter the publishing queue.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <ApproveForm itemId={itemId} disabled={!canApprove} />
        <RejectForm itemId={itemId} />
        <BacklogForm itemId={itemId} />
        {isPost && !canApprove ? (
          <span className="text-[11px] text-amber-700">
            Fix warnings before approving for the scheduled publishing queue.
          </span>
        ) : null}
      </div>
    </li>
  );
}

function ApproveForm({
  itemId,
  disabled,
}: {
  itemId: string;
  disabled: boolean;
}) {
  const [, action] = useFormState(approveItemAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="item_id" value={itemId} />
      <SubmitButton
        variant="primary"
        label="Approve for scheduled publishing"
        disabled={disabled}
      />
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
  disabled,
}: {
  variant: "primary" | "ghost";
  label: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const className =
    variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={`${className} disabled:opacity-60`}
    >
      {pending ? "…" : label}
    </button>
  );
}
