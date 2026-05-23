/**
 * Visual mock of how the post will look on Reddit. NOT pixel-perfect
 * — the goal is "this is what people will see" not "this is a Reddit
 * skin." Reddit's design will rotate; ours stays calm and familiar.
 *
 * Server component. Renders title, subreddit, author (operator
 * handle), body or link, and the creative thumbnail.
 */

import type { CreativeType } from "@/lib/supabase/types";

export interface RedditPostPreviewProps {
  subreddit: string;
  authorHandle: string | null;
  title: string;
  body: string | null;
  linkUrl: string | null;
  scheduledAt: string | null;
  creative: {
    assetUrl: string | null;
    altText: string | null;
    creativeType: CreativeType;
    mimeType: string | null;
  } | null;
}

export function RedditPostPreview(props: RedditPostPreviewProps) {
  const isLink = Boolean(props.linkUrl && !props.body);
  const isVideo =
    props.creative?.creativeType === "video" ||
    props.creative?.mimeType === "video/mp4" ||
    props.creative?.mimeType === "video/webm";
  const time = props.scheduledAt
    ? formatRelative(props.scheduledAt)
    : "just now";

  return (
    <article className="rounded-2xl border border-ink-200 bg-white overflow-hidden max-w-2xl">
      <header className="px-4 py-3 border-b border-ink-100 flex items-center gap-2 text-[11px] text-ink-600">
        <div className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 grid place-items-center font-bold text-[11px]">
          r/
        </div>
        <span className="font-semibold text-ink-900">r/{props.subreddit}</span>
        <span className="text-ink-300">•</span>
        <span>
          Posted by{" "}
          <span className="text-ink-700">
            u/{props.authorHandle ?? "operator"}
          </span>
        </span>
        <span className="text-ink-300">•</span>
        <span>{time}</span>
      </header>

      <div className="p-4 space-y-3">
        <h3 className="text-base font-semibold text-ink-900 leading-snug">
          {props.title}
        </h3>

        {props.creative?.assetUrl ? (
          <div className="rounded-md overflow-hidden border border-ink-100 bg-ink-50">
            {isVideo ? (
              <video
                src={props.creative.assetUrl}
                muted
                playsInline
                preload="metadata"
                controls
                className="w-full max-h-96 object-contain bg-black"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={props.creative.assetUrl}
                alt={props.creative.altText ?? ""}
                className="w-full max-h-96 object-contain"
              />
            )}
          </div>
        ) : null}

        {isLink && props.linkUrl ? (
          <a
            href={props.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-md border border-ink-200 px-3 py-2 text-sm text-signal-700 hover:bg-ink-50 break-all"
          >
            {props.linkUrl}
          </a>
        ) : props.body ? (
          <div className="text-sm text-ink-800 whitespace-pre-wrap leading-relaxed">
            {props.body}
          </div>
        ) : (
          <p className="text-xs text-ink-400 italic">
            (No body or link — the title carries the post.)
          </p>
        )}
      </div>

      <footer className="px-4 py-2.5 border-t border-ink-100 text-[11px] text-ink-400 flex items-center gap-4">
        <span>▲ 0 ▼</span>
        <span>0 comments</span>
        <span>Share</span>
        <span>Save</span>
      </footer>
    </article>
  );
}

function formatRelative(iso: string): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return "scheduled";
    const abs = Math.abs(ms);
    const seconds = abs / 1000;
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;
    const suffix = ms > 0 ? "from now" : "ago";
    if (days >= 1) return `${days.toFixed(0)}d ${suffix}`;
    if (hours >= 1) return `${hours.toFixed(0)}h ${suffix}`;
    if (minutes >= 1) return `${minutes.toFixed(0)}m ${suffix}`;
    return `${Math.max(1, Math.floor(seconds))}s ${suffix}`;
  } catch {
    return "scheduled";
  }
}
