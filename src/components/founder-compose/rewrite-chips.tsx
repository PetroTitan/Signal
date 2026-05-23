"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  rewriteDraftAction,
  type RewriteDraftActionResult,
} from "@/app/(app)/weekly-plan/_rewrite-action";
import {
  REWRITE_ACTION_LABELS,
  REWRITE_ACTIONS,
  type RewriteAction,
} from "@/core/generation/rewrite-types";

interface RewriteChipsProps {
  itemId: string | null;
  /** True when at least one AI provider is configured server-side. */
  providerAvailable: boolean;
  /** True when the current draft body is non-empty. */
  hasBody: boolean;
  /** Optional founder-readable provider label for the receipt line. */
  providerLabel?: string | null;
}

/**
 * Phase F4.6 — inline editorial chips on the compose sheet.
 *
 * Renders 8 small chips below the body editor. Each tap fires
 * rewriteDraftAction with the chosen action and refreshes the
 * compose state via the router. Per the brief, NOT a dropdown
 * forest; NOT a settings page; NOT an AI playground.
 *
 * Disabled when:
 *   - the draft is brand-new (no itemId yet — autosave hasn't fired)
 *   - the body is empty
 *   - no AI provider is configured
 */
export function RewriteChips(props: RewriteChipsProps) {
  const [pendingAction, setPendingAction] = useState<RewriteAction | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const disabledReason = !props.itemId
    ? "Save the draft first (wait a second for autosave) before rewriting."
    : !props.hasBody
      ? "Write something first."
      : !props.providerAvailable
        ? "AI rewrites aren't connected yet — set ANTHROPIC_API_KEY or OPENAI_API_KEY."
        : null;

  async function fire(action: RewriteAction) {
    if (!props.itemId) return;
    setPendingAction(action);
    setError(null);
    setReceipt(null);
    const fd = new FormData();
    fd.set("item_id", props.itemId);
    fd.set("action", action);
    const initial: RewriteDraftActionResult = { ok: false, error: "" };
    const result = await rewriteDraftAction(initial, fd);
    setPendingAction(null);
    if (result.ok) {
      setReceipt(
        `${REWRITE_ACTION_LABELS[action]} · Generated with ${result.providerLabel}${
          result.truncated ? " (response was truncated)" : ""
        }`,
      );
      startTransition(() => router.refresh());
    } else {
      setError(result.error || "Couldn't finish the rewrite.");
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Editorial rewrites
        </span>
        {disabledReason ? (
          <span className="text-[10px] text-ink-400">{disabledReason}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {REWRITE_ACTIONS.map((action) => {
          const pending = pendingAction === action;
          const disabled = pendingAction !== null || !!disabledReason;
          return (
            <button
              key={action}
              type="button"
              onClick={() => fire(action)}
              disabled={disabled}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                pending
                  ? "bg-signal-100 border-signal-300 text-signal-800"
                  : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {pending ? "Working…" : REWRITE_ACTION_LABELS[action]}
            </button>
          );
        })}
      </div>
      {receipt ? (
        <p className="text-[10px] text-emerald-700 leading-relaxed">
          {receipt}
        </p>
      ) : null}
      {error ? (
        <p className="text-[10px] text-amber-700 leading-relaxed">{error}</p>
      ) : null}
    </div>
  );
}
