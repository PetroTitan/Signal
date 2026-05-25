"use client";

/**
 * Compose-sheet tab strip: Editor / Platform preview / Metadata.
 *
 * Pure presentational. The parent owns the active tab. Switching
 * tabs has zero side effects — no save, no autosave, no schedule
 * mutation, no rewrite. The preview tab passes its render hint
 * (the platform string) through to the body via the `renderPreview`
 * prop so the parent decides which platform card to mount.
 */

import { renderPlatformPreview } from "@/core/platform-preview/preview-renderer";
import type {
  PreviewInput,
  PreviewPlatform,
} from "@/core/platform-preview/preview-types";
import { BlueskyPreview } from "./BlueskyPreview";
import { LinkedInPreview } from "./LinkedInPreview";
import { XPreview } from "./XPreview";

export type ComposeTab = "editor" | "preview" | "metadata";

export function PreviewTabsHeader({
  active,
  onChange,
  previewAvailable,
}: {
  active: ComposeTab;
  onChange: (next: ComposeTab) => void;
  previewAvailable: boolean;
}) {
  const tabs: Array<{ id: ComposeTab; label: string; disabled?: boolean }> = [
    { id: "editor", label: "Editor" },
    { id: "preview", label: "Platform preview", disabled: !previewAvailable },
    { id: "metadata", label: "Metadata / debug" },
  ];
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 border-b border-ink-100 px-1"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            aria-selected={isActive}
            className={`text-[11px] font-medium px-3 py-2 -mb-px border-b-2 transition-colors ${
              isActive
                ? "border-signal-500 text-signal-800"
                : "border-transparent text-ink-500 hover:text-ink-800"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {tab.label}
            {tab.disabled ? (
              <span className="ml-1 text-[10px] text-ink-400">
                (not available for this platform)
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Renders the per-platform card for a given preview input. Returns
 * null for unsupported platforms (the editor tab is the fallback).
 */
export function PreviewCard({
  input,
  platform,
}: {
  input: PreviewInput;
  platform: PreviewPlatform;
}) {
  const result = renderPlatformPreview({ ...input, platform });
  switch (platform) {
    case "bluesky":
      return <BlueskyPreview result={result} />;
    case "x":
      return <XPreview result={result} />;
    case "linkedin":
      return <LinkedInPreview result={result} />;
  }
}
