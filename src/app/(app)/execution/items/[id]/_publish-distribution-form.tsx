"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  recordManualDistributionAction,
  type RecordManualDistributionResult,
} from "./_record-manual-distribution-action";

const initial: RecordManualDistributionResult = { ok: false, error: "" };

export type DistributionPlatform =
  | "x"
  | "linkedin"
  | "youtube"
  | "threads"
  | "instagram";

interface PublishDistributionFormProps {
  executionItemId: string;
  platform: DistributionPlatform;
  /** Pre-formatted preview produced by the platform-specific transformer. */
  preview:
    | {
        kind: "x_thread";
        parts: { text: string }[];
        fullText: string;
        shareIntentUrl: string;
      }
    | {
        kind: "linkedin_post";
        text: string;
        warnings: string[];
        shareIntentUrl: string;
      }
    | {
        kind: "youtube_assets";
        title: string;
        description: string;
        tags: string[];
        chapters: Array<{ timestamp: string; label: string }>;
        thumbnailIdea: string | null;
        pinnedCommentSuggestion: string | null;
        shortsHook: string | null;
        warnings: string[];
        fullText: string;
        shareIntentUrl: string;
      }
    | {
        kind: "threads_post";
        text: string;
        warnings: string[];
        shareIntentUrl: string;
      }
    | {
        kind: "instagram_assets";
        caption: string;
        carouselOutline: Array<{ slide: number; label: string; text: string }>;
        reelHook: string;
        reelCaption: string;
        hashtags: string[];
        warnings: string[];
        fullText: string;
        shareIntentUrl: string;
      };
  /** Soft cooldown notice from cadence-cooldown, if any. */
  cooldownWarning?: string | null;
}

const PLATFORM_LABEL: Record<DistributionPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  threads: "Threads",
  instagram: "Instagram",
};

const CONFIRMATION_HINT: Record<DistributionPlatform, string> = {
  x: "Paste the URL of your X post (or the first post in the thread).",
  linkedin: "Paste the URL of your LinkedIn post.",
  youtube: "Paste the URL of the YouTube video.",
  threads: "Paste the URL of your Threads post.",
  instagram: "Paste the URL of your Instagram post.",
};

const PERMALINK_PLACEHOLDER: Record<DistributionPlatform, string> = {
  x: "https://x.com/yourhandle/status/…",
  linkedin: "https://www.linkedin.com/posts/…",
  youtube: "https://youtube.com/watch?v=… or https://youtu.be/…",
  threads: "https://www.threads.net/@yourhandle/post/…",
  instagram: "https://www.instagram.com/p/…",
};

export function PublishDistributionForm(props: PublishDistributionFormProps) {
  const [state, action] = useFormState(recordManualDistributionAction, initial);
  const safe = state ?? initial;
  const label = PLATFORM_LABEL[props.platform];

  return (
    <section className="rounded-2xl border border-emerald-200 bg-white p-5 space-y-4">
      <header>
        <h2 className="text-sm font-semibold text-ink-900">
          Publish manually on {label}
        </h2>
        <p className="text-xs text-ink-700 mt-1 leading-relaxed">
          Signal prepared the post in {label}&apos;s shape. Copy it, post it
          on {label}, then paste the resulting permalink back so Signal
          records the result.
        </p>
      </header>

      {props.cooldownWarning ? (
        <p className="text-xs text-amber-700 leading-relaxed">
          {props.cooldownWarning}
        </p>
      ) : null}

      {props.preview.kind === "x_thread" ? (
        <XThreadPreview preview={props.preview} />
      ) : props.preview.kind === "linkedin_post" ? (
        <LinkedInPreview preview={props.preview} />
      ) : props.preview.kind === "youtube_assets" ? (
        <YouTubePreview preview={props.preview} />
      ) : props.preview.kind === "threads_post" ? (
        <ThreadsPreview preview={props.preview} />
      ) : (
        <InstagramPreview preview={props.preview} />
      )}

      <form action={action} className="space-y-3 border-t border-ink-100 pt-4">
        <input
          type="hidden"
          name="execution_item_id"
          value={props.executionItemId}
        />
        <input type="hidden" name="platform" value={props.platform} />
        <label className="block text-xs">
          <div className="font-semibold text-ink-700 mb-1">
            {label} permalink
          </div>
          <input
            type="url"
            name="permalink"
            placeholder={PERMALINK_PLACEHOLDER[props.platform]}
            required
            className="input w-full text-sm font-mono"
          />
          <div className="text-[11px] text-ink-500 mt-1 leading-relaxed">
            {CONFIRMATION_HINT[props.platform]}
          </div>
        </label>
        <label className="block text-xs">
          <div className="font-semibold text-ink-700 mb-1">
            Notes (optional)
          </div>
          <textarea
            name="operator_notes"
            rows={2}
            placeholder="Anything to remember about this post."
            className="input w-full text-sm"
          />
        </label>
        <div className="flex items-center gap-3 flex-wrap">
          <RecordButton label={label} />
          {safe.ok ? (
            <span className="text-xs text-emerald-700 leading-relaxed">
              ✓ Recorded.{" "}
              <a
                href={safe.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Open on {label}
              </a>
            </span>
          ) : safe.error ? (
            <span className="text-xs text-amber-700 leading-relaxed">
              {safe.error}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function RecordButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending
        ? "Recording…"
        : `Record as published on ${label}`}
    </button>
  );
}

function XThreadPreview({
  preview,
}: {
  preview: Extract<
    PublishDistributionFormProps["preview"],
    { kind: "x_thread" }
  >;
}) {
  const total = preview.parts.length;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Thread preview
        </span>
        <span className="text-[11px] text-ink-500">
          {total} {total === 1 ? "post" : "posts"}
        </span>
      </div>
      <ol className="space-y-2">
        {preview.parts.map((part, idx) => (
          <li
            key={idx}
            className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-800 leading-relaxed whitespace-pre-wrap"
          >
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[10px] font-semibold text-ink-500">
                Post {idx + 1} / {total}
              </span>
              <span className="text-[10px] text-ink-400">
                {part.text.length} chars
              </span>
            </div>
            {part.text}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy first post" value={preview.parts[0]?.text ?? ""} />
        <CopyButton label="Copy entire thread" value={preview.fullText} />
        <a
          href={preview.shareIntentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open X composer →
        </a>
      </div>
      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>Click <span className="font-medium">Open X composer</span> — the first post is pre-filled.</li>
        <li>Click Post on X.</li>
        {total > 1 ? (
          <li>For each subsequent thread part, reply to your previous post with the copied text.</li>
        ) : null}
        <li>Copy the resulting permalink and paste it below.</li>
      </ol>
    </div>
  );
}

function LinkedInPreview({
  preview,
}: {
  preview: Extract<
    PublishDistributionFormProps["preview"],
    { kind: "linkedin_post" }
  >;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          LinkedIn preview
        </span>
        <span className="text-[11px] text-ink-500">
          {preview.text.length} chars
        </span>
      </div>
      <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-800 leading-relaxed whitespace-pre-wrap">
        {preview.text}
      </div>
      {preview.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-700 space-y-0.5 leading-relaxed">
          {preview.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy post" value={preview.text} />
        <a
          href={preview.shareIntentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open LinkedIn composer →
        </a>
      </div>
      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>Click <span className="font-medium">Copy post</span> to copy the body.</li>
        <li>Click <span className="font-medium">Open LinkedIn composer</span> and paste.</li>
        <li>Click Post on LinkedIn.</li>
        <li>Copy the permalink from your feed and paste it below.</li>
      </ol>
    </div>
  );
}

function YouTubePreview({
  preview,
}: {
  preview: Extract<
    PublishDistributionFormProps["preview"],
    { kind: "youtube_assets" }
  >;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          YouTube upload assets
        </span>
        <span className="text-[11px] text-ink-500">
          {preview.title.length} title chars
        </span>
      </div>
      <div className="space-y-2">
        <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold text-ink-500 mb-1">
            Title
          </div>
          <div className="text-sm text-ink-900 leading-relaxed">
            {preview.title || "(no title)"}
          </div>
        </div>
        <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold text-ink-500 mb-1">
            Description
          </div>
          <div className="text-xs text-ink-800 leading-relaxed whitespace-pre-wrap">
            {preview.description || "(no description)"}
          </div>
        </div>
        {preview.chapters.length > 0 ? (
          <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
            <div className="text-[10px] font-semibold text-ink-500 mb-1">
              Chapters (edit timestamps after upload)
            </div>
            <ol className="text-xs font-mono text-ink-800 space-y-0.5">
              {preview.chapters.map((c, idx) => (
                <li key={idx}>
                  {c.timestamp} {c.label}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {preview.tags.length > 0 ? (
          <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
            <div className="text-[10px] font-semibold text-ink-500 mb-1">
              Tags
            </div>
            <div className="text-xs text-ink-800">
              {preview.tags.join(", ")}
            </div>
          </div>
        ) : null}
        {preview.thumbnailIdea ? (
          <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-2 text-xs text-ink-700">
            <div className="text-[10px] font-semibold text-ink-500 mb-1">
              Thumbnail idea
            </div>
            {preview.thumbnailIdea}
          </div>
        ) : null}
        {preview.shortsHook ? (
          <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-2 text-xs text-ink-700">
            <div className="text-[10px] font-semibold text-ink-500 mb-1">
              Shorts hook
            </div>
            {preview.shortsHook}
          </div>
        ) : null}
        {preview.pinnedCommentSuggestion ? (
          <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-2 text-xs text-ink-700 whitespace-pre-wrap">
            <div className="text-[10px] font-semibold text-ink-500 mb-1">
              Pinned comment suggestion
            </div>
            {preview.pinnedCommentSuggestion}
          </div>
        ) : null}
      </div>
      {preview.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-700 space-y-0.5 leading-relaxed">
          {preview.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy title" value={preview.title} />
        <CopyButton label="Copy description" value={preview.description} />
        <CopyButton label="Copy tags" value={preview.tags.join(", ")} />
        <CopyButton label="Copy everything" value={preview.fullText} />
        <a
          href={preview.shareIntentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open YouTube Studio →
        </a>
      </div>
      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>
          Click <span className="font-medium">Open YouTube Studio</span> and
          upload your video.
        </li>
        <li>
          Paste title, description, and tags using the Copy buttons.
        </li>
        <li>
          After upload, edit chapter timestamps to match your video.
        </li>
        <li>Paste the resulting video URL below.</li>
      </ol>
    </div>
  );
}

function ThreadsPreview({
  preview,
}: {
  preview: Extract<
    PublishDistributionFormProps["preview"],
    { kind: "threads_post" }
  >;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Threads preview
        </span>
        <span className="text-[11px] text-ink-500">
          {preview.text.length} chars
        </span>
      </div>
      <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-800 leading-relaxed whitespace-pre-wrap">
        {preview.text}
      </div>
      {preview.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-700 space-y-0.5 leading-relaxed">
          {preview.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy post" value={preview.text} />
        <a
          href={preview.shareIntentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open Threads composer →
        </a>
      </div>
      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>Click Copy post.</li>
        <li>Open Threads, paste, and click Post.</li>
        <li>Copy the permalink from your profile and paste it below.</li>
      </ol>
    </div>
  );
}

function InstagramPreview({
  preview,
}: {
  preview: Extract<
    PublishDistributionFormProps["preview"],
    { kind: "instagram_assets" }
  >;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Instagram assets
        </span>
        <span className="text-[11px] text-ink-500">
          {preview.caption.length} caption chars
        </span>
      </div>
      <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
        <div className="text-[10px] font-semibold text-ink-500 mb-1">
          Caption
        </div>
        <div className="text-xs text-ink-800 leading-relaxed whitespace-pre-wrap">
          {preview.caption || "(empty)"}
        </div>
      </div>
      {preview.hashtags.length > 0 ? (
        <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-800">
          <span className="text-[10px] font-semibold text-ink-500 mr-2">
            Hashtags:
          </span>
          {preview.hashtags.map((h) => `#${h}`).join(" ")}
        </div>
      ) : null}
      {preview.carouselOutline.some((s) => s.text.length > 0) ? (
        <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-2">
          <div className="text-[10px] font-semibold text-ink-500 mb-1">
            Carousel outline (text only — turn each slide into an image)
          </div>
          <ol className="text-xs text-ink-700 space-y-1">
            {preview.carouselOutline.map((s) => (
              <li key={s.slide}>
                <span className="font-semibold">
                  Slide {s.slide} · {s.label}:
                </span>{" "}
                {s.text || "(empty)"}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/40 px-3 py-2 text-xs text-ink-700">
        <div className="text-[10px] font-semibold text-ink-500 mb-1">
          Reel
        </div>
        <div className="font-medium text-ink-800">Hook: {preview.reelHook}</div>
        <div className="mt-1 whitespace-pre-wrap">
          {preview.reelCaption || "(no reel caption)"}
        </div>
      </div>
      {preview.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-700 space-y-0.5 leading-relaxed">
          {preview.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy caption" value={preview.caption} />
        <CopyButton label="Copy everything" value={preview.fullText} />
        <a
          href={preview.shareIntentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open Instagram →
        </a>
      </div>
      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>Prepare your image, carousel, or reel.</li>
        <li>Click Copy caption.</li>
        <li>Open Instagram (mobile recommended), upload, paste caption.</li>
        <li>Copy the post permalink and paste it below.</li>
      </ol>
    </div>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      disabled={value.length === 0}
      className="btn-ghost text-xs disabled:opacity-50"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}
