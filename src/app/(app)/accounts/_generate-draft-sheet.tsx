"use client";

import { useState, useTransition } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import {
  generateDraftAction,
  type GenerateDraftResult,
} from "./_generate-draft-action";
import { PlatformNativePreview } from "./_platform-native-preview";

const initial: GenerateDraftResult = { ok: false, error: "" };

interface GenerateDraftSheetProps {
  open: boolean;
  onClose: () => void;
  identity: {
    id: string;
    platform: string;
    platformLabel: string;
    displayName: string | null;
    productId: string | null;
  };
  /** True when an AI provider is configured server-side. */
  providerAvailable: boolean;
}

export function GenerateDraftSheet(props: GenerateDraftSheetProps) {
  const [state, formAction] = useFormState(generateDraftAction, initial);
  const safe = state ?? initial;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [topic, setTopic] = useState("");

  if (!props.open) return null;

  // After a successful generation the sheet flips to a preview mode
  // that renders the platform-native envelope (creative direction,
  // warnings, transformation notes). The operator explicitly clicks
  // "Open in weekly plan" to navigate — no auto-navigate, so the
  // preview is actually readable. The button below also calls
  // router.refresh so the new plan item lands on the weekly-plan
  // page without a hard reload.
  const statusBanner = safe.ok
    ? statusBannerCopy(safe.status, safe.providerUsed)
    : null;
  const envelope = safe.ok ? safe.platformNativeDraft : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch md:items-center justify-center bg-ink-900/40"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close generate draft"
        onClick={props.onClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative w-full md:max-w-2xl bg-white md:rounded-2xl md:my-8 md:max-h-[90vh] flex flex-col overflow-hidden md:shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-900">
              Generate draft
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {props.identity.displayName ?? props.identity.platform} ·{" "}
              {props.identity.platformLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="btn-ghost text-xs"
          >
            Close
          </button>
        </div>

        {safe.ok ? (
          <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 space-y-4">
            <div
              role="status"
              className="rounded-md bg-emerald-50 text-emerald-800 px-3 py-2 text-xs leading-relaxed"
            >
              {statusBanner}
              {safe.similarityWarning ? (
                <div className="mt-1 text-amber-800">
                  {safe.similarityWarning}
                </div>
              ) : null}
            </div>

            {envelope ? (
              <PlatformNativePreview draft={envelope} />
            ) : (
              // Silent fallback for older drafts / non-founder platforms:
              // surface a calm, operator-facing note pointing them at
              // the weekly plan to finish writing. No internal field
              // names; no implication that anything went wrong.
              <div className="rounded-md border border-ink-200 bg-white p-4 text-xs text-ink-600 leading-relaxed">
                Draft saved. Open it on the weekly plan to review the body
                and finish writing.
              </div>
            )}
          </div>
        ) : (
        <form
          action={formAction}
          className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 space-y-4"
        >
          <input type="hidden" name="identity_id" value={props.identity.id} />
          <input
            type="hidden"
            name="platform"
            value={props.identity.platform}
          />
          {props.identity.productId ? (
            <input
              type="hidden"
              name="product_id"
              value={props.identity.productId}
            />
          ) : null}

          {!props.providerAvailable ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs text-amber-900 leading-relaxed">
              AI draft generation isn&apos;t connected yet. Signal will
              seed the draft with your topic, goal, and source — you can
              finish writing in the compose sheet, or have Claude / Codex
              fill it in via MCP.
            </div>
          ) : null}

          <label className="block">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Topic or idea
              </span>
              <span className="text-[10px] text-ink-400">required</span>
            </div>
            <textarea
              name="topic"
              required
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="What is this post about?"
              className="input w-full text-sm leading-relaxed"
              autoFocus
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Goal (optional)
            </div>
            <textarea
              name="goal"
              rows={2}
              maxLength={1000}
              placeholder="What should this post accomplish?"
              className="input w-full text-sm"
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                CTA shape (optional)
              </div>
              <input
                type="text"
                name="cta"
                maxLength={300}
                placeholder="Invite feedback, share build update, etc."
                className="input w-full text-sm"
              />
            </label>
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Tone adjustment (optional)
              </div>
              <input
                type="text"
                name="tone_adjustment"
                maxLength={300}
                placeholder="Calmer / more technical / lighter"
                className="input w-full text-sm"
              />
            </label>
          </div>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Source URL (optional)
            </div>
            <input
              type="url"
              name="source_url"
              maxLength={600}
              placeholder="https://… (article, repo, or page being summarized)"
              className="input w-full text-sm font-mono"
            />
            <p className="mt-1 text-[10px] text-ink-400 leading-relaxed">
              When set, the draft summarizes cautiously and stores the
              URL as the canonical reference.
            </p>
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Schedule note (optional)
            </div>
            <input
              type="text"
              name="schedule_preference"
              maxLength={120}
              placeholder="e.g. tomorrow morning"
              className="input w-full text-sm"
            />
          </label>

          {safe.error ? (
            <div
              role="alert"
              className="rounded-md bg-amber-50 text-amber-800 px-3 py-2 text-xs leading-relaxed"
            >
              {safe.error}
            </div>
          ) : null}
        </form>
        )}

        <div
          className="flex items-center justify-between gap-2 px-4 py-3 border-t border-ink-100 shrink-0 bg-white"
          style={{
            paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
          }}
        >
          {safe.ok ? (
            <>
              <p className="text-[11px] text-ink-500 leading-snug">
                Open the draft on the weekly plan to edit and schedule.
              </p>
              <button
                type="button"
                onClick={() => {
                  props.onClose();
                  startTransition(() => router.push("/weekly-plan"));
                }}
                className="btn-primary text-sm"
              >
                Open in weekly plan
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] text-ink-500 leading-snug">
                Drafts land as <span className="font-medium">draft</span>.
                You review, edit, schedule, and approve before publishing.
              </p>
              <SubmitButton disabled={topic.trim().length === 0} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending ? "Drafting…" : "Generate draft"}
    </button>
  );
}

type GenerationOkStatus =
  | "provider_generated"
  | "manual_seed_created"
  | "provider_unavailable"
  | "provider_refused";

function statusBannerCopy(
  status: GenerationOkStatus,
  providerUsed: boolean,
): string {
  switch (status) {
    case "provider_generated":
      return "Draft created — review before publishing.";
    case "provider_refused":
      return "Provider tried but tripped a safety rule. A seeded draft was created instead — finish it manually.";
    case "provider_unavailable":
      return providerUsed
        ? "Draft created — review before publishing."
        : "Draft seeded with your inputs — open it on the weekly plan to finish writing.";
    case "manual_seed_created":
      return "Draft seeded with your inputs — open it on the weekly plan to finish writing.";
  }
}
