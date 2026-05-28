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
  type RewriteAction,
} from "@/core/generation/rewrite-types";
import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";

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
 * Compact destination chip label per platform. The Adapt-for chips
 * keep their underlying rewrite action ids (REWRITE_ACTION_LABELS
 * stays unchanged for the receipt copy + analytics keys) but the
 * compose-sheet surface presents them as destination names instead
 * of "Adapt for X" — Signal is publishing infrastructure, not an AI
 * rewrite tool.
 */
const DESTINATION_CHIP_LABEL: Record<FounderPlatform, string> = {
  reddit: "Reddit",
  bluesky: "Bluesky",
  devto: "dev.to",
  hashnode: "Hashnode",
  telegram: "Telegram",
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  threads: "Threads",
  instagram: "Instagram",
  indie_hackers: "Indie Hackers",
};

/**
 * Mapping from FounderPlatform → existing rewrite action (when one
 * exists). Click on a destination chip with a mapped action triggers
 * the existing draft-adapt flow; click on a chip without a mapping
 * is display-only.
 *
 * The 4 destinations without an adapt action (Telegram, Hashnode,
 * Reddit, Indie Hackers) intentionally render as display-only chips
 * — they appear in the destination row so the operator sees the
 * full publishing surface, but Signal does not "rewrite for
 * Telegram" today.
 */
const DESTINATION_REWRITE_ACTION: Partial<Record<FounderPlatform, RewriteAction>> = {
  bluesky: "to_bluesky_thread",
  devto: "to_devto_article",
  x: "to_x_thread",
  linkedin: "to_linkedin_post",
  youtube: "to_youtube_description",
  threads: "to_threads_post",
  instagram: "to_instagram_caption",
};

/**
 * Editorial polish actions — kept inline in the chips panel but
 * presented under a small secondary heading so destinations lead.
 */
const POLISH_ACTIONS: ReadonlyArray<RewriteAction> = [
  "rewrite",
  "shorter",
  "more_technical",
  "more_founder",
  "less_promotional",
  "improve_headline",
];

/**
 * Capability badge text per platform — derived from
 * `platform-guidance.publishingMode`. Static, truthful, and matches
 * what the /settings/publishing-platforms and /accounts capabilities
 * panel show. We do NOT fabricate per-identity connection state
 * here — that's resolved on /accounts, not the compose sheet.
 */
function capabilityBadge(platform: FounderPlatform): string {
  const meta = resolveIdentityPlatformGuidance(platform);
  if (!meta) return "Manual";
  if (meta.publishingMode === "api") return "API";
  // distributionOnly + manual platforms (LinkedIn / YouTube / Threads
  // / Instagram / Indie Hackers) — manual until the publisher lands.
  return "Manual";
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

  const globalDisabled =
    pendingAction !== null || undoPending || !!disabledReason;

  return (
    <div className="space-y-3">
      {/* ─────────────── Publish destinations ─────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Publish destinations
          </span>
          {disabledReason ? (
            <span className="text-[10px] text-ink-400">{disabledReason}</span>
          ) : providerHint ? (
            <span className="text-[10px] text-ink-400">{providerHint}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FOUNDER_PLATFORMS.map((platform) => {
            const label = DESTINATION_CHIP_LABEL[platform];
            const action = DESTINATION_REWRITE_ACTION[platform];
            const badge = capabilityBadge(platform);
            const pending = action !== undefined && pendingAction === action;
            // Chips without a rewrite action render as display-only —
            // they show the destination + capability so the operator
            // sees the full publishing surface without misleading them
            // into expecting a "rewrite for Telegram" or
            // "rewrite for Indie Hackers" affordance Signal doesn't
            // ship today.
            if (!action) {
              return (
                <span
                  key={platform}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-ink-200 bg-white text-ink-700 inline-flex items-center gap-1.5 select-none cursor-default"
                  title={`${label} · ${badge}`}
                >
                  <span>{label}</span>
                  <span className="text-[9px] uppercase tracking-wide text-ink-400">
                    {badge}
                  </span>
                </span>
              );
            }
            return (
              <button
                key={platform}
                type="button"
                onClick={() => fire(action)}
                disabled={globalDisabled}
                title={`Adapt draft for ${label} (${badge})`}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                  pending
                    ? "bg-signal-100 border-signal-300 text-signal-800"
                    : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span>{pending ? "Working…" : label}</span>
                {!pending ? (
                  <span className="text-[9px] uppercase tracking-wide text-ink-400">
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─────────────── Polish (editorial actions) ─────────────── */}
      <div className="space-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Polish
        </span>
        <div className="flex flex-wrap gap-1.5">
          {POLISH_ACTIONS.map((action) => {
            const pending = pendingAction === action;
            return (
              <button
                key={action}
                type="button"
                onClick={() => fire(action)}
                disabled={globalDisabled}
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
