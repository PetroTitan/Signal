"use client";

/**
 * First-class creative approval surface for the weekly-plan card.
 *
 * Why this exists
 * ---------------
 * Before this component, when a plan_item had an attached creative
 * in `pending_review` and the operator tried to approve the post,
 * the server-side gate refused with the (correct, but unhelpful)
 * message "Creative needs to be approved before the post can be
 * approved." There was no button anywhere that flipped the
 * creative's status. The only path was reopening the compose modal
 * and resubmitting the attach form with approve_now=true — opaque
 * enough that operators read the refusal as "the system will
 * approve it automatically" and bounced.
 *
 * This component renders two CTAs directly on the card whenever
 * the attached creative is in `pending_review`. It also renders
 * the workflow explanation banner and (optional) source-of-truth
 * debug disclosure mandated by the product spec.
 *
 * Server actions live in `_actions.ts` (`approveCreativeAction`,
 * `rejectCreativeAction`). Both re-validate the creative's
 * readiness before flipping status, so this UI cannot weaken the
 * approval boundary.
 */

import { useEffect } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  approveCreativeAction,
  rejectCreativeAction,
  type ApproveCreativeResult,
  type RejectCreativeResult,
} from "./_actions";
import type { WeeklyPlanItemStatus } from "@/lib/supabase/types";

const approveInitial: ApproveCreativeResult = { ok: false, error: "" };
const rejectInitial: RejectCreativeResult = { ok: false, error: "" };

export type CreativeStatusToken =
  | "none"
  | "planned"
  | "pending_review"
  | "approved"
  | "rejected";

/**
 * Narrow a raw `weekly_plan_item_creatives.status` string (or
 * `null` when no creative is attached) into the operator-facing
 * token the controls component consumes. Exported so the card +
 * compose modal map identically.
 */
export function toCreativeStatusToken(
  status: string | null | undefined,
): CreativeStatusToken {
  if (!status) return "none";
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "planned") return "planned";
  return "pending_review";
}

export interface CreativeApprovalControlsProps {
  creativeId: string | null;
  creativeStatus: CreativeStatusToken;
  postStatus: WeeklyPlanItemStatus;
  /** Optional structured blockers to render in the debug section. */
  approvalBlockers?: ReadonlyArray<string>;
  /** Optional callback fired when the operator successfully approves
   *  the creative. The compose modal uses this to refresh its local
   *  draft.creativeStatus so the buttons disappear live without a
   *  server round-trip. The card path doesn't need it — the action
   *  revalidatePath("/weekly-plan") re-renders the page. */
  onCreativeApproved?: () => void;
  /** Same for reject. */
  onCreativeRejected?: () => void;
}

export function CreativeApprovalControls(props: CreativeApprovalControlsProps) {
  const isPendingReview =
    props.creativeStatus === "pending_review" && props.creativeId !== null;
  const postIsTerminal =
    props.postStatus === "published" || props.postStatus === "rejected";

  // We render the workflow explainer and debug surface whenever the
  // card has a creative — even when no controls are needed — so the
  // operator can ALWAYS see the rule and the state. The CTAs only
  // appear when the creative is actually awaiting review.
  if (props.creativeId === null && props.creativeStatus === "none") {
    return null;
  }

  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2.5 mt-1 space-y-2">
      <WorkflowBanner />

      {isPendingReview && !postIsTerminal ? (
        <div className="flex flex-wrap items-center gap-2">
          <ApproveCreativeButton
            creativeId={props.creativeId!}
            onSuccess={props.onCreativeApproved}
          />
          <RejectCreativeButton
            creativeId={props.creativeId!}
            onSuccess={props.onCreativeRejected}
          />
        </div>
      ) : null}

      <DebugSurface
        creativeId={props.creativeId}
        creativeStatus={props.creativeStatus}
        postStatus={props.postStatus}
        approvalBlockers={props.approvalBlockers ?? []}
      />
    </div>
  );
}

function WorkflowBanner() {
  return (
    <p className="text-[11px] text-ink-600 leading-relaxed">
      <span className="font-semibold text-ink-800">Creative must be approved</span>{" "}
      before the post itself can be approved. Approve the creative below, or
      reject and replace it.
    </p>
  );
}

// ---------------------------------------------------------------------
// Approve button — form-action, sends creative_id
// ---------------------------------------------------------------------

function ApproveCreativeButton({
  creativeId,
  onSuccess,
}: {
  creativeId: string;
  onSuccess?: () => void;
}) {
  const [state, action] = useFormState(approveCreativeAction, approveInitial);
  // Fire the optional success callback exactly once per ok transition.
  // Watching `state` is sufficient — useFormState swaps the reference
  // only when the action returns.
  useEffect(() => {
    if (state?.ok) onSuccess?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form action={action} className="inline-flex flex-col gap-1">
      <input type="hidden" name="creative_id" value={creativeId} />
      <ApproveSubmit />
      {state && !state.ok && state.error ? (
        <span className="text-[11px] text-amber-700">{state.error}</span>
      ) : null}
    </form>
  );
}

function ApproveSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs px-3 py-1 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
    >
      {pending ? "Approving…" : "Approve creative"}
    </button>
  );
}

// ---------------------------------------------------------------------
// Reject button — same shape
// ---------------------------------------------------------------------

function RejectCreativeButton({
  creativeId,
  onSuccess,
}: {
  creativeId: string;
  onSuccess?: () => void;
}) {
  const [state, action] = useFormState(rejectCreativeAction, rejectInitial);
  useEffect(() => {
    if (state?.ok) onSuccess?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form action={action} className="inline-flex flex-col gap-1">
      <input type="hidden" name="creative_id" value={creativeId} />
      <RejectSubmit />
      {state && !state.ok && state.error ? (
        <span className="text-[11px] text-amber-700">{state.error}</span>
      ) : null}
    </form>
  );
}

function RejectSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs px-3 py-1 rounded-md border bg-white border-ink-200 text-ink-700 hover:bg-ink-50 disabled:opacity-50"
    >
      {pending ? "Rejecting…" : "Reject creative"}
    </button>
  );
}

// ---------------------------------------------------------------------
// Debug surface — DB truth, behind a disclosure
// ---------------------------------------------------------------------

function DebugSurface(props: {
  creativeId: string | null;
  creativeStatus: CreativeStatusToken;
  postStatus: WeeklyPlanItemStatus;
  approvalBlockers: ReadonlyArray<string>;
}) {
  const publishReadiness =
    props.postStatus === "published"
      ? "published"
      : props.postStatus === "scheduled"
        ? "scheduled (scheduler will publish)"
        : props.approvalBlockers.length === 0 && props.creativeStatus === "approved"
          ? "ready for post approval"
          : "blocked";
  return (
    <details className="rounded border border-ink-100 bg-ink-50/50 px-2 py-1">
      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-ink-500">
        Debug — DB source of truth
      </summary>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono">
        <dt className="text-ink-500">plan_item.status</dt>
        <dd className="text-ink-800">{props.postStatus}</dd>
        <dt className="text-ink-500">creative.status</dt>
        <dd className="text-ink-800">{props.creativeStatus}</dd>
        <dt className="text-ink-500">effective_readiness</dt>
        <dd className="text-ink-800">{publishReadiness}</dd>
        <dt className="text-ink-500">creative_id</dt>
        <dd className="text-ink-800 break-all">{props.creativeId ?? "—"}</dd>
      </dl>
      {props.approvalBlockers.length > 0 ? (
        <>
          <div className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-500">
            approval_blockers
          </div>
          <ul className="text-[11px] text-ink-800 space-y-0.5 mt-0.5">
            {props.approvalBlockers.map((b, i) => (
              <li key={i}>· {b}</li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
