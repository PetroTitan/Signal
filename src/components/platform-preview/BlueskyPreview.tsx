"use client";

/**
 * Deterministic Bluesky preview card. Renders the operator-visible
 * shape of the post — single post or vertically-stacked thread — with
 * no fake metrics, no scraped data, no live embeds.
 *
 * The thread layout uses numbered connectors so the operator can see
 * where each part will split when published.
 */

import type { PreviewResult } from "@/core/platform-preview/preview-types";
import {
  LengthMeter,
  PreviewCreativeBlock,
  PreviewIdentityHeader,
  PreviewWarnings,
} from "./preview-shared";

export function BlueskyPreview({ result }: { result: PreviewResult }) {
  return (
    <div className="space-y-3">
      <PreviewWarnings warnings={result.warnings} />
      <div className="rounded-2xl border border-ink-200 bg-white max-w-[560px]">
        {result.parts.map((part, i) => (
          <div
            key={i}
            className={`p-4 ${i > 0 ? "border-t border-ink-100" : ""} relative`}
          >
            <PreviewIdentityHeader identity={result.identity} />
            {result.parts.length > 1 ? (
              <div className="absolute top-3 right-3 text-[10px] tabular-nums text-ink-500">
                {part.index} / {part.total}
              </div>
            ) : null}
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-900">
              {part.text}
            </div>
            {part.showsCreative && result.creative ? (
              <PreviewCreativeBlock creative={result.creative} aspect="feed" />
            ) : null}
            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
              <span>{handleSuffix(result.identity.handle)}</span>
              <LengthMeter length={part.length} budget={part.budget} />
            </div>
            {part.index < part.total ? (
              <div className="absolute left-8 -bottom-2 h-4 w-px bg-ink-200" />
            ) : null}
          </div>
        ))}
      </div>
      {result.transformationNotes.length > 0 ? (
        <p className="text-[10px] text-ink-400 leading-relaxed">
          {result.transformationNotes.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function handleSuffix(handle: string | null): string {
  if (!handle) return "";
  return handle.includes(".") ? handle : `${handle}.bsky.social`;
}
