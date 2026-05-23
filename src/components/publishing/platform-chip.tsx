/**
 * Phase F4 — platform chip.
 *
 * Small visual identifier for "where a post will go" or "where it
 * was published". Used in cards, lists, and the compose sheet. Pure
 * presentational component — no data fetching, no side effects.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";

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

const VISUAL: Record<string, PlatformVisual> = {
  reddit: { label: "Reddit", short: "r/", cls: "bg-orange-100 text-orange-800" },
  x: { label: "X", short: "X", cls: "bg-ink-900 text-white" },
  linkedin: { label: "LinkedIn", short: "in", cls: "bg-sky-100 text-sky-800" },
  devto: { label: "dev.to", short: "dev", cls: "bg-ink-100 text-ink-800" },
  hashnode: { label: "Hashnode", short: "Hn", cls: "bg-blue-100 text-blue-800" },
  bluesky: { label: "Bluesky", short: "Bs", cls: "bg-sky-100 text-sky-700" },
};

const FALLBACK: PlatformVisual = {
  label: "Platform",
  short: "·",
  cls: "bg-ink-100 text-ink-700",
};

export function PlatformChip({ platform, href, size = "sm" }: PlatformChipProps) {
  const v = VISUAL[platform] ?? FALLBACK;
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
