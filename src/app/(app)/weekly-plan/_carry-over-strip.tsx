"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { carryOverPlanItemAction } from "./_actions";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import type { ActionResult } from "@/lib/forms/action-result";
import type { WeeklyPlanItemStatus } from "@/lib/supabase/types";

/**
 * A6 — "Unfinished from previous weeks" surface.
 *
 * Lists items still in flight in OLDER weekly plans (which the
 * current-week views hide) and offers an audited "Carry over" action
 * that relocates the item into the current plan WITHOUT changing its
 * status (approval preserved) or touching its execution item. Read +
 * one safe relocation only.
 */

export interface CarryOverItem {
  id: string;
  title: string | null;
  status: WeeklyPlanItemStatus;
  platform: string | null;
}

const initial: ActionResult = { ok: false, error: "" };

function CarryOverButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn text-[11px] shrink-0 disabled:opacity-50"
    >
      {pending ? "Carrying over…" : "Carry over →"}
    </button>
  );
}

function CarryOverRow({ item }: { item: CarryOverItem }) {
  const [state, formAction] = useFormState(carryOverPlanItemAction, initial);
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-amber-100 bg-white px-3 py-2">
      <span className="min-w-0 flex-1 flex items-center gap-2">
        <ExecutionStateBadge status={item.status} />
        <span className="text-sm text-ink-800 truncate">
          {item.title?.trim() || "Untitled item"}
        </span>
      </span>
      <form action={formAction} className="shrink-0 flex items-center gap-2">
        <input type="hidden" name="item_id" value={item.id} />
        {state.ok ? (
          <span className="text-[11px] text-emerald-700">Moved ✓</span>
        ) : (
          <CarryOverButton />
        )}
      </form>
    </li>
  );
}

export function CarryOverStrip({ items }: { items: CarryOverItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-baseline justify-between mb-2 gap-3">
        <h2 className="text-sm font-semibold text-ink-900">
          Unfinished from previous weeks
        </h2>
        <span className="text-[11px] text-ink-500">
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="text-[11px] text-ink-600 mb-2 leading-relaxed">
        These items are still in flight in earlier plans. Carry one over to
        bring it into this week — its status and schedule are preserved.
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <CarryOverRow key={item.id} item={item} />
        ))}
      </ul>
      <div className="mt-2 text-right">
        <Link
          href="/activity"
          className="text-[11px] text-ink-500 hover:text-ink-700"
        >
          View activity log →
        </Link>
      </div>
    </section>
  );
}
