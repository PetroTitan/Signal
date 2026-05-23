"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  removePlanItemAction,
  type RemovePlanItemResult,
} from "./_actions";
import type { WeeklyPlanItemStatus } from "@/lib/supabase/types";

const initial: RemovePlanItemResult = { ok: false, error: "" };

interface RemoveButtonProps {
  itemId: string;
  status: WeeklyPlanItemStatus;
  /** Optional small variant for the publishing-detail surface. */
  size?: "sm" | "md";
}

interface CopyPack {
  /** Button label. */
  label: string;
  /** Confirmation modal title. */
  confirmTitle: string;
  /** Confirmation modal body. */
  confirmBody: string;
  /** Confirm-button label. */
  confirmCta: string;
  /** True when the action should warn the founder before firing. */
  needsConfirm: boolean;
}

const COPY: Partial<Record<WeeklyPlanItemStatus, CopyPack | null>> = {
  draft: {
    label: "Delete draft",
    confirmTitle: "Delete this draft?",
    confirmBody: "This draft is gone for good. No publish has happened yet.",
    confirmCta: "Delete draft",
    needsConfirm: true,
  },
  pending_approval: {
    label: "Remove from plan",
    confirmTitle: "Remove from plan?",
    confirmBody:
      "This post leaves the plan and the approval queue. It will not publish.",
    confirmCta: "Remove",
    needsConfirm: true,
  },
  approved: {
    label: "Cancel before publishing",
    confirmTitle: "Cancel this post?",
    confirmBody:
      "This will stop Signal from publishing this post. The schedule is cleared and the post is removed from the plan.",
    confirmCta: "Cancel post",
    needsConfirm: true,
  },
  scheduled: {
    label: "Cancel scheduled post",
    confirmTitle: "Cancel this scheduled post?",
    confirmBody:
      "This will stop Signal from publishing this post. The schedule is cleared and the post is removed from the plan.",
    confirmCta: "Cancel post",
    needsConfirm: true,
  },
  rejected: {
    label: "Delete",
    confirmTitle: "Delete this post?",
    confirmBody:
      "This post is already off your active plan. Removing it deletes the record.",
    confirmCta: "Delete",
    needsConfirm: false,
  },
  skipped: {
    label: "Delete",
    confirmTitle: "Delete this post?",
    confirmBody:
      "This post was skipped. Removing it deletes the record.",
    confirmCta: "Delete",
    needsConfirm: false,
  },
  backlog: {
    label: "Delete from backlog",
    confirmTitle: "Delete from backlog?",
    confirmBody: "Removes the backlog entry permanently.",
    confirmCta: "Delete",
    needsConfirm: false,
  },
  paused: {
    label: "Delete",
    confirmTitle: "Delete this paused post?",
    confirmBody: "Removes the paused post permanently.",
    confirmCta: "Delete",
    needsConfirm: true,
  },
  // No button for these — published posts must not be silently destroyed.
  published: null,
};

export function RemoveButton(props: RemoveButtonProps) {
  const copy = COPY[props.status];
  const [state, action] = useFormState(removePlanItemAction, initial);
  const safe = state ?? initial;
  const [open, setOpen] = useState(false);

  if (!copy) return null;

  const sizeClass = props.size === "md" ? "text-xs" : "text-[11px]";

  const inlineForm = (
    <form action={action} className="inline">
      <input type="hidden" name="item_id" value={props.itemId} />
      <ConfirmSubmit label={copy.confirmCta} />
    </form>
  );

  if (!copy.needsConfirm) {
    return (
      <div className="inline-flex items-center gap-2">
        {inlineForm}
        {safe.error ? (
          <span className="text-[11px] text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`btn-ghost ${sizeClass} text-red-700 hover:bg-red-50`}
      >
        {copy.label}
      </button>
      {safe.error && !open ? (
        <span className="ml-2 text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 px-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute inset-0 cursor-default"
          />
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-ink-900">
              {copy.confirmTitle}
            </h2>
            <p className="text-xs text-ink-700 leading-relaxed">
              {copy.confirmBody}
            </p>
            {safe.error ? (
              <p className="text-xs text-amber-700">{safe.error}</p>
            ) : null}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost text-xs"
              >
                Keep this post
              </button>
              <form action={action} className="inline">
                <input type="hidden" name="item_id" value={props.itemId} />
                <ConfirmSubmit label={copy.confirmCta} variant="danger" />
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ConfirmSubmit({
  label,
  variant = "ghost",
}: {
  label: string;
  variant?: "ghost" | "danger";
}) {
  const { pending } = useFormStatus();
  const className =
    variant === "danger"
      ? "text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
      : "btn-ghost text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-50";
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? "Removing…" : label}
    </button>
  );
}
