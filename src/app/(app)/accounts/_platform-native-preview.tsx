/**
 * Compose-sheet preview for the platform-native draft envelope.
 *
 * Pure presentational. Renders the structured envelope produced by
 * generateDraft so the operator sees the platform shape, the
 * creative direction, the warnings, and the transformation notes
 * BEFORE navigating to the weekly plan to edit.
 *
 * Copy rules:
 *   - Operator-facing language. No "creativeDirection" / "transformationNotes"
 *     enum names rendered in the panel.
 *   - Never implies a visual exists ("the screenshot shows…" is wrong).
 *     All copy describes what the operator should create.
 *   - For Instagram + YouTube the media block flips to a prominent
 *     "Visual required" treatment so it's obvious the draft is
 *     incomplete without it.
 */

// React import keeps the classic JSX transform happy in the
// vitest renderer; Next.js itself uses the automatic runtime so
// this is a no-op at app runtime.
import React from "react";
import type {
  CreativeDirection,
  PlatformNativeDraft,
  PlatformNativeFormat,
  PlatformRiskLevel,
} from "@/core/platform-native";
import { CopyButton } from "./_copy-button";

interface PlatformNativePreviewProps {
  draft: PlatformNativeDraft;
}

// =====================================================================
// Display helpers — operator-facing labels for enum-shaped fields.
// =====================================================================

const FORMAT_LABEL: Record<PlatformNativeFormat, string> = {
  single_post: "Single post",
  thread: "Thread",
  long_form_article: "Long-form article",
  carousel: "Carousel",
  channel_update: "Channel update",
  video_description: "Video description (title · description · chapters)",
  caption: "Caption (paired with a visual)",
  discussion_post: "Discussion post",
};

const MEDIA_TYPE_LABEL: Record<string, string> = {
  none: "Text-only — no media needed",
  screenshot: "Screenshot",
  diagram: "Diagram",
  chart: "Chart",
  carousel: "Carousel (multiple slides)",
  short_video: "Short video",
  animation: "Animation",
  thumbnail: "Thumbnail",
  screen_recording: "Screen recording",
  hero_image: "Hero image",
  static_image: "Static image",
};

const PLATFORM_LABEL: Record<string, string> = {
  reddit: "Reddit",
  x: "X",
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  threads: "Threads",
  instagram: "Instagram",
  telegram: "Telegram",
  devto: "dev.to",
  hashnode: "Hashnode",
  youtube: "YouTube",
  indie_hackers: "Indie Hackers",
};

const RISK_LABEL: Record<PlatformRiskLevel, string> = {
  low: "Low risk",
  medium: "Caution — review before publishing",
  high: "High risk — read warnings carefully",
};

const RISK_TONE: Record<PlatformRiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-800 border-emerald-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  high: "bg-red-50 text-red-800 border-red-200",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

function mediaTypeLabel(type: string): string {
  return MEDIA_TYPE_LABEL[type] ?? type;
}

// =====================================================================
// Component
// =====================================================================

export function PlatformNativePreview({ draft }: PlatformNativePreviewProps) {
  const platform = platformLabel(draft.platform);
  const format = FORMAT_LABEL[draft.format] ?? draft.format;

  return (
    <div
      className="space-y-4 rounded-md border border-ink-200 bg-white p-4 text-sm"
      data-testid="platform-native-preview"
    >
      {/* Header: platform + format + risk pill */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Preview for {platform}
          </div>
          <div className="text-[13px] text-ink-700 mt-0.5">{format}</div>
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${RISK_TONE[draft.riskLevel]}`}
          data-testid="risk-pill"
        >
          {RISK_LABEL[draft.riskLevel]}
        </span>
      </header>

      {/* Warnings — surfaced near the top so the operator sees them
          before reading the body. Don't render anything when empty. */}
      {draft.warnings.length > 0 ? (
        <section
          className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900 leading-relaxed"
          data-testid="warnings-block"
        >
          <div className="font-semibold mb-1">Heads up</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {draft.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Title (only when the platform uses one) */}
      {draft.title ? (
        <section>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Title
          </div>
          <p className="text-[14px] font-semibold text-ink-900 leading-snug">
            {draft.title}
          </p>
        </section>
      ) : null}

      {/* Hook (lead sentence) */}
      {draft.hook ? (
        <section>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Opening
          </div>
          <p className="text-[13px] text-ink-800 leading-relaxed">{draft.hook}</p>
        </section>
      ) : null}

      {/* Body */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Body
          </div>
          <CopyButton value={draft.body} label="body" />
        </div>
        <pre className="text-[12px] text-ink-800 leading-relaxed whitespace-pre-wrap font-sans">
          {draft.body}
        </pre>
      </section>

      {/* CTA — only when the engine produced one */}
      {draft.cta ? (
        <section>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Call to action
            </div>
            <CopyButton value={draft.cta} label="CTA" />
          </div>
          <p className="text-[12px] text-ink-700 leading-relaxed italic">
            {draft.cta}
          </p>
        </section>
      ) : null}

      {/* Creative direction — the required block. Render distinct
          treatments for "media required" vs "media optional". */}
      <CreativeDirectionBlock direction={draft.creativeDirection} />

      {/* Transformation notes — why this draft fits the platform */}
      {draft.transformationNotes.length > 0 ? (
        <section data-testid="transformation-notes">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Why this fits {platform}
          </div>
          <ul className="text-[12px] text-ink-700 leading-relaxed list-disc pl-4 space-y-0.5">
            {draft.transformationNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// =====================================================================
// Creative direction block — handles required vs optional treatment
// =====================================================================

function CreativeDirectionBlock({
  direction,
}: {
  direction: CreativeDirection;
}) {
  const requiredTone = direction.mediaRequired
    ? "border-red-300 bg-red-50/60"
    : "border-ink-200 bg-ink-50/50";

  return (
    <section
      className={`rounded-md border p-3 ${requiredTone}`}
      data-testid="creative-direction-block"
      data-media-required={direction.mediaRequired ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Media
        </div>
        {direction.mediaRequired ? (
          <span
            className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800"
            data-testid="media-required-badge"
          >
            Visual required
          </span>
        ) : (
          <span
            className="inline-flex items-center rounded-full border border-ink-200 bg-white px-2 py-0.5 text-[10px] font-medium text-ink-600"
            data-testid="media-optional-badge"
          >
            Optional
          </span>
        )}
      </div>

      <div className="text-[12px] text-ink-700">
        <span className="font-medium">Visual type:</span>{" "}
        {mediaTypeLabel(direction.mediaType)}
      </div>

      <div className="mt-2 text-[12px] text-ink-700 leading-relaxed">
        <div className="flex items-start justify-between gap-2 mb-1">
          <span className="font-medium">What to create:</span>
          <CopyButton value={direction.mediaPromptOrBrief} label="brief" />
        </div>
        <div>{direction.mediaPromptOrBrief}</div>
      </div>

      {direction.mediaRequired ? (
        <div
          className="mt-2 text-[11px] text-red-700 font-medium leading-relaxed"
          data-testid="media-incomplete-warning"
        >
          This draft is not complete until you create and attach the visual
          described above. Do not publish without it.
        </div>
      ) : null}

      {direction.mediaRiskNotes.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-ink-600 mb-1">
            Don&apos;t do
          </div>
          <ul
            className="text-[11px] text-ink-600 leading-relaxed list-disc pl-4 space-y-0.5"
            data-testid="media-risk-notes"
          >
            {direction.mediaRiskNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
