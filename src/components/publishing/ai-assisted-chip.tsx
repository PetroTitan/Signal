/**
 * Phase F4.6.1 — internal AI-assisted visibility chip.
 *
 * Tiny calm chip rendered on the plan-item card when a draft has
 * been touched by AI generation or rewriting. Purely internal to
 * Signal — NEVER appended to the published post body, NEVER stored
 * in publish_history, NEVER surfaced to platform APIs.
 *
 * States derived from weekly_plan_items.metadata:
 *   - `generated_by === "identity_aware_generation"` → "AI draft"
 *   - has `last_rewrite_at` but no `generated_by`       → "AI-assisted"
 *   - neither                                           → null (no chip)
 */

import type { ReactNode } from "react";

export type AiAssistedKind = "ai_draft" | "ai_assisted";

interface AiAssistedChipProps {
  kind: AiAssistedKind;
}

const META: Record<AiAssistedKind, { label: string; bg: string; text: string }> = {
  ai_draft: {
    label: "AI draft",
    bg: "bg-signal-50",
    text: "text-signal-700",
  },
  ai_assisted: {
    label: "AI-assisted",
    bg: "bg-ink-100",
    text: "text-ink-700",
  },
};

export function AiAssistedChip({ kind }: AiAssistedChipProps): ReactNode {
  const meta = META[kind];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.bg} ${meta.text}`}
      title="Internal indicator. Not added to the published post."
    >
      <span className="font-mono opacity-70">AI</span>
      {meta.label}
    </span>
  );
}

/**
 * Pure helper — derive the chip kind from a plan-item's metadata.
 * Returns null when the draft is purely manual.
 */
export function deriveAiAssistedKind(
  metadata: Record<string, unknown> | null | undefined,
): AiAssistedKind | null {
  if (!metadata) return null;
  const generatedBy = metadata.generated_by;
  if (generatedBy === "identity_aware_generation") return "ai_draft";
  if (typeof metadata.last_rewrite_at === "string") return "ai_assisted";
  return null;
}
