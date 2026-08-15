/**
 * Phase F4 — platform chip.
 *
 * Small visual identifier for "where a post will go" or "where it
 * was published". Used in cards, lists, and the compose sheet. Pure
 * presentational component — no data fetching, no side effects.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";
import { resolveIdentityPlatformGuidance } from "@/core/publishing/platform-guidance";

interface PlatformChipProps {
  platform: PublishPlatform | string;
  /** Optional permalink — when set, the chip becomes a link. */
  href?: string | null;
  /** "sm" (default) or "md" — md is for header positions. */
  size?: "sm" | "md";
}

interface PlatformVisual {
  label: string;
  short: string;
  /** Tailwind background + text. */
  cls: string;
}

/**
 * Per-platform brand tint. Deliberately NOT Signal blue — a platform
 * chip identifies a destination, it is not a navigation control.
 *
 * Label and short text are NOT listed here: they come from the
 * editorial registry, so a chip can never disagree with the destination
 * selector about what a platform is called. This map used to carry both
 * and covered only six platforms, so a Telegram item rendered as the
 * literal word "Platform" with a "·" glyph.
 */
const TINT: Record<string, string> = {
  reddit: "bg-orange-100 text-orange-800",
  x: "bg-ink-900 text-white",
  linkedin: "bg-sky-100 text-sky-800",
  devto: "bg-ink-100 text-ink-800",
  hashnode: "bg-blue-100 text-blue-800",
  bluesky: "bg-sky-100 text-sky-700",
  telegram: "bg-cyan-100 text-cyan-800",
  youtube: "bg-red-100 text-red-800",
  threads: "bg-ink-200 text-ink-900",
  instagram: "bg-fuchsia-100 text-fuchsia-800",
  indie_hackers: "bg-violet-100 text-violet-800",
};

const FALLBACK_TINT = "bg-ink-100 text-ink-700";

function resolveVisual(platform: string): PlatformVisual {
  const guidance = resolveIdentityPlatformGuidance(platform);
  return {
    // An unrecognized slug renders its own value rather than the word
    // "Platform" — a legacy row should show what it actually says.
    label: guidance?.label ?? platform,
    short: guidance?.short ?? "·",
    cls: TINT[platform] ?? FALLBACK_TINT,
  };
}

export function PlatformChip({ platform, href, size = "sm" }: PlatformChipProps) {
  const v = resolveVisual(platform);
  const pad =
    size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  const inner = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${v.cls} ${pad}`}
    >
      <span className="font-mono text-[10px] opacity-80">{v.short}</span>
      {v.label}
    </span>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex hover:opacity-80 transition-opacity"
      >
        {inner}
      </a>
    );
  }
  return inner;
}
