"use client";

/**
 * Tiny click-to-copy button for the platform-native preview.
 *
 * Conditional render: callers should only mount this component
 * when `value` has actual content. The component itself returns
 * null when `value` is null / empty, so an accidental empty value
 * still renders nothing — defense in depth.
 *
 * Pure client-side. Uses navigator.clipboard.writeText. Feedback is
 * a 2-second label swap from "Copy" to "Copied" so the operator
 * sees confirmation without a full toast surface.
 */

import React, { useState } from "react";

interface CopyButtonProps {
  /** The text to copy. When null / empty the button renders nothing. */
  value: string | null;
  /** Operator-facing label shown on the button before clicking. */
  label: string;
  /** Label shown immediately after a successful copy. */
  copiedLabel?: string;
}

export function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  if (value === null || value.trim().length === 0) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value as string);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
      window.setTimeout(() => setState("idle"), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label.toLowerCase()}`}
      className="inline-flex items-center rounded border border-ink-200 bg-white px-2 py-0.5 text-[10px] font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-800 transition-colors"
      data-testid="copy-button"
      data-state={state}
    >
      {state === "copied"
        ? copiedLabel
        : state === "failed"
          ? "Couldn't copy"
          : `Copy ${label}`}
    </button>
  );
}
