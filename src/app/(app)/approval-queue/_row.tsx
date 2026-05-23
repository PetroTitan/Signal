"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  approveItemAction,
  moveToBacklogAction,
  rejectItemAction,
  type ApprovalActionState,
} from "./_actions";
import {
  CreativeCard,
  type CreativeCardData,
} from "@/components/publishing/creative-card";
import { PlatformBadge } from "@/components/badges";
import type { PlatformId } from "@/types";

const initial: ApprovalActionState = { ok: false, error: null };

export interface ApprovalRowProps {
  itemId: string;
  title: string | null;
  platform: string | null;
  contentType: string | null;
  body: string | null;
  riskLevel: string | null;
  scheduledAt: string | null;
  accountLabel: string | null;
  productName: string | null;
  creative: CreativeCardData | null;
  warnings: string[];
  isPost: boolean;
  canApprove: boolean;
}

export function ApprovalRow(props: ApprovalRowProps) {
  const {
    itemId,
    title,
    platform,
    body,
    scheduledAt,
    accountLabel,
    productName,
    creative,
    warnings,
    isPost,
    canApprove,
  } = props;
  const isPlatform = (p: string | null): p is PlatformId =>
    p === "reddit" || p === "x" || p === "linkedin";

  return (
    <li className="px-5 py-5">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4">
        <div className="min-w-0 space-y-2.5">
          {/* Title + metadata */}
          <div>
            <div className="text-sm font-semibold text-ink-900 leading-snug">
              {title ?? "Untitled"}
            </div>
            <div className="text-[11px] text-ink-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {isPlatform(platform) ? (
                <PlatformBadge platform={platform} />
              ) : platform ? (
                <span className="text-ink-700">{platform}</span>
              ) : (
                <span className="text-ink-400">no platform</span>
              )}
              <span className="text-ink-300">•</span>
              <span>
                {scheduledAt
                  ? new Date(scheduledAt).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "no schedule"}
              </span>
              {accountLabel ? (
                <>
                  <span className="text-ink-300">•</span>
                  <span className="text-ink-600">{accountLabel}</span>
                </>
              ) : null}
              {productName ? (
                <>
                  <span className="text-ink-300">•</span>
                  <span className="text-ink-600">{productName}</span>
                </>
              ) : null}
            </div>
          </div>

          {body ? (
            <p className="text-xs text-ink-700 leading-relaxed line-clamp-3">
              {body}
            </p>
          ) : null}

          {warnings.length > 0 ? (
            <div className="rounded-md bg-amber-50 border border-amber-100 px-3 py-2">
              <div className="text-[11px] font-semibold text-amber-800 mb-0.5">
                Resolve before approval
              </div>
              <ul className="text-[11px] text-amber-800 leading-relaxed space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {!isPost ? (
            <p className="text-[11px] text-ink-500 italic">
              Comments are draft-only — approving keeps this as a draft, it
              does not enter the publishing queue.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 items-center pt-1">
            <ApproveForm itemId={itemId} disabled={!canApprove} />
            <RejectForm itemId={itemId} />
            <BacklogForm itemId={itemId} />
            {isPost && canApprove ? (
              <span className="text-[11px] text-ink-500">
                Approving sends this to the publishing queue — it does not
                publish now.
              </span>
            ) : null}
          </div>
        </div>

        {/* Creative card on the right (or below on mobile) */}
        <div className="order-first md:order-none">
          {isPost ? (
            <CreativeCard creative={creative} density="compact" />
          ) : null}
        </div>
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
      className={`${className} text-xs disabled:opacity-60`}
    >
      {pending ? "…" : label}
    </button>
  );
}
