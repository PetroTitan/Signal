"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createAccountAction,
  type CreateAccountResult,
} from "./_actions";
import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";

const initial: CreateAccountResult = { ok: false, error: "" };

const VOICE_PROFILE_PLACEHOLDER = `Writes calm, technical founder posts about AI systems, SEO, automation, and startup operations.

Avoid hype.
Avoid fake authority.
Prefer honest operational insights.`;

interface AccountCreateFormProps {
  products: { id: string; name: string }[];
}

export function AccountCreateForm({ products }: AccountCreateFormProps) {
  const [state, formAction] = useFormState(createAccountAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [platform, setPlatform] = useState<FounderPlatform | "">("");

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setPlatform("");
    }
  }, [state]);

  const safe = state ?? initial;
  const guidance = platform ? resolveIdentityPlatformGuidance(platform) : null;

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-ink-900">
        Add a publishing identity
      </h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        A publishing identity is the voice Signal writes in. Pick the
        platform, give it a name, and describe how it sounds.
      </p>

      <form ref={formRef} action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="platform" value={platform} />

        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Connected platform
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FOUNDER_PLATFORMS.map((p) => {
              const meta = resolveIdentityPlatformGuidance(p);
              if (!meta) return null;
              const selected = platform === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlatform(p)}
                  className={`text-[11px] px-3 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                    selected
                      ? "bg-signal-50 border-signal-300 text-signal-800"
                      : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                  }`}
                >
                  <span className="font-mono text-[10px] opacity-80">
                    {meta.short}
                  </span>
                  {meta.label}
                </button>
              );
            })}
          </div>
          {guidance ? (
            <p className="text-[11px] text-ink-500 leading-relaxed">
              {guidance.voiceHint}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Name
            </div>
            <input
              type="text"
              name="display_name"
              required
              placeholder="e.g. Petro · founder voice"
              className="input w-full"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Handle (optional)
            </div>
            <input
              type="text"
              name="handle"
              placeholder="@yourhandle"
              className="input w-full font-mono text-xs"
            />
          </label>
          <label className="block md:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Product (optional)
            </div>
            <select name="product_id" className="input w-full">
              <option value="">—</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              How this identity writes
            </span>
            <span className="text-[10px] text-ink-400">
              500–1500 chars recommended
            </span>
          </div>
          <textarea
            name="voice_profile"
            rows={6}
            maxLength={1500}
            placeholder={VOICE_PROFILE_PLACEHOLDER}
            className="input w-full text-sm leading-relaxed"
          />
          <p className="mt-1 text-[10px] text-ink-400 leading-relaxed">
            This becomes the writing context for AI-assisted drafts. Free
            text — no formatting needed.
          </p>
        </label>

        {safe.ok ? (
          <div
            role="status"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
          >
            Publishing identity added. It shows in the list above.
          </div>
        ) : safe.error ? (
          <div
            role="alert"
            className="text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
          >
            {safe.error}
          </div>
        ) : null}

        <SubmitButton />
      </form>

      <p className="mt-4 text-[11px] text-ink-500 leading-relaxed">
        Signal never asks for platform passwords, cookies, or session
        tokens. Connections happen through each platform&apos;s official
        method — OAuth, API key, or app-password — and are managed
        separately under each identity.
      </p>
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary disabled:opacity-60"
    >
      {pending ? "Saving…" : "Add identity"}
    </button>
  );
}
