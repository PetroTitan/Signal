"use client";

/**
 * Compact mini-preview for plan-item cards and the approval queue.
 *
 * Renders a small platform-shaped snippet so reviewers see what the
 * post will look like on the target platform — not just the raw body
 * dump. No engagement metrics, no fake timestamps, no scraped data.
 *
 * Shows:
 *   - first part text only (no thread expansion in mini)
 *   - small "thread of N" badge when there are multiple parts
 *   - up to 2 warning chips (most important first)
 *   - no creative thumbnail (the card already shows one)
 */

import { renderPlatformPreview } from "@/core/platform-preview/preview-renderer";
import type {
  PreviewInput,
  PreviewPlatform,
  PreviewResult,
} from "@/core/platform-preview/preview-types";

export function MiniPreview({
  input,
  platform,
  maxChars,
}: {
  input: Omit<PreviewInput, "platform">;
  platform: PreviewPlatform;
  /** Optional cap for displayed text. Default 280. */
  maxChars?: number;
}) {
  const result: PreviewResult = renderPlatformPreview({ ...input, platform });
  const first = result.parts[0];
  if (!first) return null;
  const cap = maxChars ?? 280;
  const visible =
    first.text.length > cap ? first.text.slice(0, cap).trimEnd() + "…" : first.text;
  const warningsToShow = result.warnings.slice(0, 2);

  return (
    <div className="rounded-md border border-ink-200 bg-white p-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          {platformLabel(platform)} preview
        </span>
        {result.parts.length > 1 ? (
          <span className="text-[10px] tabular-nums text-ink-500">
            thread · {result.parts.length} parts
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-ink-800 leading-relaxed whitespace-pre-wrap line-clamp-4">
        {visible}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] tabular-nums text-ink-400">
          {first.length} / {first.budget} {result.unit}
        </span>
        {warningsToShow.length > 0 ? (
          <span className="flex items-center gap-1">
            {warningsToShow.map((w, i) => (
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-100 text-amber-800"
                title={w.message}
              >
                {warningTag(w.kind)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function platformLabel(p: PreviewPlatform): string {
  switch (p) {
    case "bluesky":
      return "Bluesky";
    case "x":
      return "X";
    case "linkedin":
      return "LinkedIn";
  }
}

function warningTag(kind: string): string {
  switch (kind) {
    case "likely_truncated":
      return "truncated";
    case "too_promotional":
      return "promo";
    case "high_hashtag_density":
      return "tags";
    case "external_link_heavy":
      return "links";
    case "corporate_tone":
      return "tone";
    case "emoji_dense":
      return "emoji";
    case "alt_text_missing":
      return "alt";
    case "thread_too_long":
      return "long thread";
    case "first_post_too_short":
      return "weak hook";
    case "title_ignored_by_platform":
      return "title ignored";
    default:
      return kind;
  }
}
