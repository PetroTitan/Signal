"use client";

import { useState } from "react";
import {
  rewriteDraftAction,
  type RewriteDraftActionResult,
} from "@/app/(app)/weekly-plan/_rewrite-action";
import {
  undoRewriteAction,
  type UndoRewriteActionResult,
} from "@/app/(app)/weekly-plan/_undo-rewrite-action";
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
  /**
   * Called when a rewrite has been persisted and the compose sheet
   * should update its local draft state. Either `title` or `body`
   * (or both, for undo) will be set; unspecified fields are not
   * touched.
   */
  onApply?: (patch: { title?: string; body?: string }) => void;
}

interface LastReceipt {
  action: RewriteAction;
  providerLabel: string;
  truncated: boolean;
  undoAvailable: boolean;
  mode: "ai" | "deterministic";
  detail: string | null;
}

/**
 * Phase F4.6 + F4.6.1 — inline editorial chips with undo.
 *
 * - 8 chips below the compose body editor (Rewrite / Shorter /
 *   More technical / More founder-like / Less promotional /
 *   Adapt for Bluesky / Adapt for dev.to / Improve headline).
 * - On success the compose sheet's local draft state is updated
 *   via `onApply` so the founder sees the rewrite immediately
 *   without closing the sheet.
 * - A small "Undo" link sits beside the receipt for the most
 *   recent rewrite. Calls undoRewriteAction which restores the
 *   snapshot stored in the plan-item's metadata.
 *
 * Calm copy. No toasts. No modals. No diff panel.
 */
export function RewriteChips(props: RewriteChipsProps) {
  const [pendingAction, setPendingAction] = useState<RewriteAction | null>(
    null,
  );
  const [undoPending, setUndoPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LastReceipt | null>(null);
  const [undoneMessage, setUndoneMessage] = useState<string | null>(null);

  // The deterministic adapter is always available — it runs server-side
  // off the platform-native style profiles and forbidden-patterns
  // engine. We only disable when the operator has nothing to rewrite:
  // no item, no body. AI provider is opportunistically used by the
  // server; the chip-level UI no longer needs to know whether keys
  // are configured.
  const disabledReason = !props.itemId
    ? "Save the draft first (wait a second for autosave) before rewriting."
    : !props.hasBody
      ? "Write something first."
      : null;
  const providerHint = props.providerAvailable
    ? null
    : "AI provider unavailable — using Signal's platform-native rules.";

  async function fire(action: RewriteAction) {
    if (!props.itemId) return;
    setPendingAction(action);
    setError(null);
    setUndoneMessage(null);
    const fd = new FormData();
    fd.set("item_id", props.itemId);
    fd.set("action", action);
    const initial: RewriteDraftActionResult = { ok: false, error: "" };
    const result = await rewriteDraftAction(initial, fd);
    setPendingAction(null);
    if (result.ok) {
      // Update the local compose state IMMEDIATELY so the founder
      // sees the new content without reopening the sheet.
      props.onApply?.({
        ...(result.newTitle !== null ? { title: result.newTitle } : {}),
        ...(result.newBody !== null ? { body: result.newBody } : {}),
      });
      setReceipt({
        action,
        providerLabel: result.providerLabel,
        truncated: result.truncated,
        undoAvailable: result.undoAvailable,
        mode: result.mode,
        detail: result.receipt,
      });
    } else {
      setError(result.error || "Couldn't finish the rewrite.");
      setReceipt(null);
    }
  }

  async function fireUndo() {
    if (!props.itemId) return;
    setUndoPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("item_id", props.itemId);
    const initial: UndoRewriteActionResult = { ok: false, error: "" };
    const result = await undoRewriteAction(initial, fd);
    setUndoPending(false);
    if (result.ok) {
      props.onApply?.({
        ...(result.newTitle !== null ? { title: result.newTitle } : {}),
        ...(result.newBody !== null ? { body: result.newBody } : {}),
      });
      setReceipt(null);
      setUndoneMessage("Rewrite reverted.");
    } else {
      setError(result.error || "Couldn't undo the rewrite.");
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Editorial rewrites
        </span>
        {disabledReason ? (
          <span className="text-[10px] text-ink-400">{disabledReason}</span>
        ) : providerHint ? (
          <span className="text-[10px] text-ink-400">{providerHint}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {REWRITE_ACTIONS.map((action) => {
          const pending = pendingAction === action;
          const disabled =
            pendingAction !== null || undoPending || !!disabledReason;
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
        <p className="text-[10px] text-emerald-700 leading-relaxed flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span>
            {REWRITE_ACTION_LABELS[receipt.action]} ·{" "}
            {receipt.mode === "ai"
              ? `Generated with ${receipt.providerLabel}`
              : `Deterministic adaptation applied${receipt.detail ? ` (${receipt.detail})` : ""}`}
            {receipt.truncated ? " (response was truncated)" : ""}
          </span>
          {receipt.undoAvailable ? (
            <>
              <span aria-hidden className="text-ink-400">
                ·
              </span>
              <button
                type="button"
                onClick={fireUndo}
                disabled={undoPending}
                className="text-ink-700 underline disabled:opacity-50 hover:text-ink-900"
              >
                {undoPending ? "Undoing…" : "Undo"}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {undoneMessage ? (
        <p className="text-[10px] text-ink-500 leading-relaxed">
          {undoneMessage}
        </p>
      ) : null}
      {error ? (
        <p className="text-[10px] text-amber-700 leading-relaxed">{error}</p>
      ) : null}
    </div>
  );
}
