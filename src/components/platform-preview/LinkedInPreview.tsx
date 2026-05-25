"use client";

/**
 * Deterministic LinkedIn preview card. Renders the post with a
 * "see more" cutoff so the operator sees the slice that lands in the
 * feed vs. what's hidden until expansion.
 *
 * No fake reactions, comments, reposts, or impressions.
 */

import { useState } from "react";
import { linkedInSeeMoreOffset } from "@/core/platform-preview/linkedin-preview";
import type { PreviewResult } from "@/core/platform-preview/preview-types";
import {
  LengthMeter,
  PreviewCreativeBlock,
  PreviewIdentityHeader,
  PreviewWarnings,
} from "./preview-shared";

export function LinkedInPreview({ result }: { result: PreviewResult }) {
  const part = result.parts[0]!;
  const [expanded, setExpanded] = useState(false);
  const cutoff = linkedInSeeMoreOffset(part.text);
  const showSeeMore = cutoff !== null;
  const visible = showSeeMore && !expanded ? part.text.slice(0, cutoff) : part.text;

  return (
    <div className="space-y-3">
      <PreviewWarnings warnings={result.warnings} />
      <div className="rounded-md border border-ink-200 bg-white max-w-[560px] shadow-sm">
        <div className="p-4">
          <PreviewIdentityHeader identity={result.identity} />
          <div className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-900">
            {visible}
            {showSeeMore && !expanded ? (
              <>
                <span className="text-ink-400">…</span>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="ml-1 text-ink-500 hover:text-ink-800"
                >
                  see more
                </button>
              </>
            ) : null}
          </div>
          {result.creative ? (
            <PreviewCreativeBlock creative={result.creative} aspect="feed" />
          ) : null}
          <div className="mt-3 flex items-center justify-between text-[11px] text-ink-400">
            <span>
              {showSeeMore
                ? expanded
                  ? "Full post (above the cutoff would be the feed teaser)"
                  : `Feed shows first ~${cutoff} chars`
                : "Post fits in feed teaser"}
            </span>
            <LengthMeter length={part.length} budget={part.budget} />
          </div>
        </div>
      </div>
      {result.transformationNotes.length > 0 ? (
        <p className="text-[10px] text-ink-400 leading-relaxed">
          {result.transformationNotes.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
