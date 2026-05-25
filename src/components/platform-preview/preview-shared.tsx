"use client";

/**
 * Shared sub-components used across the per-platform preview cards.
 * No engagement metrics, no fabricated timestamps, no fake avatars.
 */

import type {
  PreviewCreative,
  PreviewIdentity,
  PreviewWarning,
} from "@/core/platform-preview/preview-types";

/**
 * Identity header — used by all platform previews. Renders the
 * operator's display name, handle, and avatar (when stored locally).
 * Never falls back to a generic avatar from a third party — when
 * avatarUrl is null we show initials.
 */
export function PreviewIdentityHeader({
  identity,
  handlePrefix,
  className,
}: {
  identity: PreviewIdentity;
  /** "@" for X, "" for Bluesky (handle already includes domain), etc. */
  handlePrefix?: string;
  className?: string;
}) {
  const initials = (identity.displayName ?? identity.handle ?? "?")
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`.trim()}>
      {identity.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={identity.avatarUrl}
          alt=""
          className="h-9 w-9 rounded-full object-cover bg-ink-100"
        />
      ) : (
        <div className="h-9 w-9 rounded-full bg-ink-200 text-ink-700 flex items-center justify-center text-[11px] font-semibold">
          {initials.length > 0 ? initials : "?"}
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink-900 truncate">
          {identity.displayName ?? identity.handle ?? "Unknown"}
        </div>
        {identity.handle ? (
          <div className="text-[12px] text-ink-500 truncate">
            {handlePrefix ?? ""}
            {identity.handle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Image affordance — renders the attached creative with alt text
 * underneath (or a warning when alt is missing). NO platform UI
 * chrome (no fake like/repost icons).
 */
export function PreviewCreativeBlock({
  creative,
  className,
  aspect,
}: {
  creative: PreviewCreative;
  /** Optional className override for layout. */
  className?: string;
  /** Aspect hint for the wrapper ("video" 16/9, "square" 1/1, "feed" 4/5). */
  aspect?: "video" | "square" | "feed" | "auto";
}) {
  const aspectClass =
    aspect === "video"
      ? "aspect-video"
      : aspect === "square"
        ? "aspect-square"
        : aspect === "feed"
          ? "aspect-[4/5]"
          : "";
  return (
    <div className={`mt-2 ${className ?? ""}`.trim()}>
      {creative.assetUrl ? (
        <div
          className={`relative overflow-hidden rounded-xl border border-ink-200 bg-ink-50 ${aspectClass}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={creative.assetUrl}
            alt={creative.altText ?? ""}
            className="block w-full h-full object-cover"
          />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-3 py-4 text-[11px] text-ink-500 italic">
          Creative planned — operator will attach asset.
        </div>
      )}
      {creative.assetUrl &&
      (!creative.altText || creative.altText.trim().length === 0) ? (
        <p className="text-[10px] text-amber-700 mt-1">
          Alt text missing — accessibility requirement.
        </p>
      ) : creative.assetUrl && creative.altText ? (
        <p className="text-[10px] text-ink-400 mt-1 italic line-clamp-2">
          alt: {creative.altText}
        </p>
      ) : null}
    </div>
  );
}

/** Warning chips — calm tone, no alarmism. */
export function PreviewWarnings({
  warnings,
  className,
}: {
  warnings: ReadonlyArray<PreviewWarning>;
  className?: string;
}) {
  if (warnings.length === 0) return null;
  return (
    <ul className={`space-y-1 ${className ?? ""}`.trim()}>
      {warnings.map((w, i) => (
        <li
          key={`${w.kind}-${i}`}
          className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2.5 py-1.5 leading-relaxed"
        >
          <span className="font-mono text-[10px] text-amber-700 mr-1.5">
            {warningLabel(w.kind)}
          </span>
          {w.message}
          {w.partIndex ? (
            <span className="text-amber-700 ml-1">
              · part {w.partIndex}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function warningLabel(kind: string): string {
  switch (kind) {
    case "likely_truncated":
      return "TRUNCATED";
    case "too_promotional":
      return "PROMO";
    case "high_hashtag_density":
      return "TAGS";
    case "external_link_heavy":
      return "LINKS";
    case "corporate_tone":
      return "TONE";
    case "emoji_dense":
      return "EMOJI";
    case "alt_text_missing":
      return "ALT";
    case "thread_too_long":
      return "THREAD";
    case "first_post_too_short":
      return "HOOK";
    case "title_ignored_by_platform":
      return "TITLE";
    default:
      return kind.toUpperCase();
  }
}

/** Length budget meter — visual fill of how much budget the part uses. */
export function LengthMeter({
  length,
  budget,
  className,
}: {
  length: number;
  budget: number;
  className?: string;
}) {
  const pct = Math.min(100, Math.round((length / budget) * 100));
  const tone =
    pct < 80
      ? "bg-emerald-400"
      : pct < 100
        ? "bg-amber-400"
        : "bg-red-500";
  return (
    <div
      className={`flex items-center gap-1.5 text-[10px] tabular-nums text-ink-500 ${className ?? ""}`.trim()}
    >
      <span>
        {length}/{budget}
      </span>
      <div className="h-1 w-16 bg-ink-100 rounded-full overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
