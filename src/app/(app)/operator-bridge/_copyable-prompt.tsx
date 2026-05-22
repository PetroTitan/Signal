"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  markOperatorRequestCopiedAction,
  type MarkCopiedResult,
} from "./_actions";

const initial: MarkCopiedResult = { ok: false, error: "" };

interface Props {
  requestId: string;
  prompt: string;
  nonce: string;
}

export function CopyableTaskPrompt({ requestId, prompt, nonce }: Props) {
  const [copied, setCopied] = useState(false);
  const [state, formAction] = useFormState(
    markOperatorRequestCopiedAction,
    initial,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Task prompt</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Copy this into Claude Code / Codex / Opus. The assistant must
            return only the JSON envelope — Signal&apos;s validator rejects
            anything else.
          </p>
          <p className="text-[11px] text-ink-500 mt-1">
            Nonce <code className="font-mono">{nonce.slice(0, 12)}…</code> is
            one-shot. Resubmitting with the same nonce will be rejected.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={copy}
            className="btn-primary text-xs whitespace-nowrap"
          >
            {copied ? "Copied!" : "Copy prompt"}
          </button>
          <form action={formAction}>
            <input type="hidden" name="request_id" value={requestId} />
            <MarkCopiedButton />
          </form>
        </div>
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap leading-relaxed bg-ink-50 border border-ink-100 rounded-md p-3 max-h-[28rem] overflow-y-auto">
        {prompt}
      </pre>
      {!safe.ok && safe.error ? (
        <p className="text-[11px] text-red-700">{safe.error}</p>
      ) : null}
    </section>
  );
}

function MarkCopiedButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-secondary text-[11px]"
      disabled={pending}
      title="Move the request to 'copied' so the timeline shows where it is."
    >
      {pending ? "…" : "Mark copied"}
    </button>
  );
}
