"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  authorizeExecutionItemAction,
  dryRunExecutionItemAction,
  type DryRunResult,
  type ItemAuthorizeResult,
} from "./_actions";
import type { ExecutionItemStatus } from "@/core/execution-engine";

const authInitial: ItemAuthorizeResult = { ok: false, error: "" };
const dryInitial: DryRunResult = { ok: false, error: "" };

const ELIGIBLE_FOR_DRY_RUN = new Set<ExecutionItemStatus>([
  "pending_authorization",
  "authorized",
  "scheduled",
  "ready",
  "paused",
  "failed",
]);

export function ItemControls({
  itemId,
  status,
}: {
  itemId: string;
  status: ExecutionItemStatus;
}) {
  if (!ELIGIBLE_FOR_DRY_RUN.has(status)) {
    return (
      <p className="text-[11px] text-ink-500">
        Item is in terminal state &mdash; no further action.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === "pending_authorization" ? (
        <AuthorizeForm itemId={itemId} />
      ) : null}
      <DryRunForm itemId={itemId} />
    </div>
  );
}

function AuthorizeForm({ itemId }: { itemId: string }) {
  const [state, formAction] = useFormState(
    authorizeExecutionItemAction,
    authInitial,
  );
  const safe = state ?? authInitial;
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="item_id" value={itemId} />
      <Submit label="Authorize" />
      {safe.ok ? (
        <span className="text-[11px] text-ink-600">{safe.reason}</span>
      ) : safe.error ? (
        <span className="text-[11px] text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function DryRunForm({ itemId }: { itemId: string }) {
  const [state, formAction] = useFormState(
    dryRunExecutionItemAction,
    dryInitial,
  );
  const safe = state ?? dryInitial;
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="item_id" value={itemId} />
      <Submit label="Dry-run" danger />
      {safe.ok ? (
        <span className="text-[11px] text-ink-600">
          {safe.outcome}: {safe.message}
        </span>
      ) : safe.error ? (
        <span className="text-[11px] text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const className = danger ? "btn-secondary text-xs" : "btn-primary text-xs";
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : label}
    </button>
  );
}
