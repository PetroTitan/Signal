"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  adaptPlanItemForPlatformAction,
  duplicatePlanItemAction,
  type DuplicatePlanItemResult,
} from "./_actions";

/**
 * Phase B6 — Reuse controls: Duplicate (same platform) + Adapt for a
 * different platform. Both create a DRAFT (status='draft') so the clone
 * must pass the normal approval flow before it can publish — never an
 * auto-publish, never an approval bypass. The original is untouched.
 */

const initial: DuplicatePlanItemResult = { ok: false, error: "" };

const ADAPT_TARGETS = ["bluesky", "x", "linkedin", "threads", "devto", "hashnode", "telegram", "reddit"];

function Pending({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn text-[11px] disabled:opacity-50">
      {pending ? "Working…" : label}
    </button>
  );
}

export function AdaptControl({
  itemId,
  sourcePlatform,
}: {
  itemId: string;
  sourcePlatform: string | null;
}) {
  const [dupState, dupAction] = useFormState(duplicatePlanItemAction, initial);
  const [adaptState, adaptAction] = useFormState(
    adaptPlanItemForPlatformAction,
    initial,
  );
  const done = dupState.ok || adaptState.ok;
  const error = dupState.error || adaptState.error;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={dupAction}>
        <input type="hidden" name="item_id" value={itemId} />
        <Pending label="Duplicate" />
      </form>
      <form action={adaptAction} className="flex items-center gap-1">
        <input type="hidden" name="item_id" value={itemId} />
        <select
          name="target_platform"
          defaultValue=""
          className="input text-[11px] py-1"
          aria-label="Adapt for platform"
        >
          <option value="" disabled>
            Adapt for…
          </option>
          {ADAPT_TARGETS.filter((p) => p !== sourcePlatform).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Pending label="Adapt" />
      </form>
      {done ? (
        <span className="text-[11px] text-emerald-700">Draft created ✓</span>
      ) : error ? (
        <span className="text-[11px] text-red-700">{error}</span>
      ) : null}
    </div>
  );
}
