"use client";

/**
 * Deterministic X/Twitter preview card. Renders a tweet (or numbered
 * thread) with the operator's content. No engagement counts, no
 * verification ticks, no scraped data.
 *
 * Layout matches X's feed shape conservatively — avatar at top-left,
 * display name + handle next to it, body below, optional image card.
 */

import type { PreviewResult } from "@/core/platform-preview/preview-types";
import {
  LengthMeter,
  PreviewCreativeBlock,
  PreviewIdentityHeader,
  PreviewWarnings,
} from "./preview-shared";

export function XPreview({ result }: { result: PreviewResult }) {
  return (
    <div className="space-y-3">
      <PreviewWarnings warnings={result.warnings} />
      <div className="rounded-2xl border border-ink-200 bg-white max-w-[560px]">
        {result.parts.map((part, i) => (
          <div
            key={i}
            className={`p-4 ${i > 0 ? "border-t border-ink-100" : ""} relative`}
          >
            <PreviewIdentityHeader
              identity={result.identity}
              handlePrefix="@"
            />
            {result.parts.length > 1 ? (
              <div className="absolute top-3 right-3 text-[10px] tabular-nums text-ink-500">
                {part.index}/{part.total}
              </div>
            ) : null}
            <div className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-ink-900">
              {linkify(part.text)}
            </div>
            {part.showsCreative && result.creative ? (
              <PreviewCreativeBlock
                creative={result.creative}
                aspect="video"
              />
            ) : null}
            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
              <span>
                {part.truncated ? (
                  <span className="text-red-700">Truncated to fit 280.</span>
                ) : (
                  ""
                )}
              </span>
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

/** Visually inline-color URLs without making them clickable. We do
 *  NOT add link previews — that would require fetching the URL. */
function linkify(text: string) {
  const out: Array<string | { url: string }> = [];
  const re = /https?:\/\/[^\s]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((piece, i) =>
    typeof piece === "string" ? (
      <span key={i}>{piece}</span>
    ) : (
      <span key={i} className="text-blue-600 break-all">
        {piece.url}
      </span>
    ),
  );
}
