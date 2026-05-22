"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createOperatorTokenAction,
  type CreateTokenResult,
} from "./_actions";

const initial: CreateTokenResult = { ok: false, error: "" };

export function CreateTokenForm({
  scopes,
}: {
  scopes: { scope: string; label: string }[];
}) {
  const [state, formAction] = useFormState(
    createOperatorTokenAction,
    initial,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
    }
  }, [state]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">Create operator token</h2>
      <form ref={formRef} action={formAction} className="space-y-3 text-sm">
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Name
          </div>
          <input
            type="text"
            name="name"
            required
            className="input w-full"
            placeholder="claude-code-local-laptop"
          />
        </label>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Scopes
          </legend>
          <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1 max-h-60 overflow-y-auto border border-ink-100 rounded p-2">
            {scopes.map((s) => (
              <label key={s.scope} className="flex items-start gap-2 text-xs text-ink-700">
                <input type="checkbox" name="scopes" value={s.scope} />
                <span>
                  <code className="font-mono text-[11px]">{s.scope}</code>{" "}
                  <span className="text-ink-500">— {s.label}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Expires (optional, ISO timestamp)
          </div>
          <input
            type="datetime-local"
            name="expires_at"
            className="input w-full"
          />
        </label>

        <div className="flex items-center gap-3">
          <Submit />
          {!safe.ok && safe.error ? (
            <span className="text-[11px] text-red-700">{safe.error}</span>
          ) : null}
        </div>
      </form>

      {safe.ok ? (
        <div className="rounded-md border border-green-300 bg-green-50 p-3 mt-2 space-y-2">
          <div className="text-xs text-green-800 font-semibold">
            Token created — copy it now. Signal will not show it again.
          </div>
          <code className="block font-mono text-[11px] break-all bg-white border border-ink-100 rounded px-2 py-2">
            {safe.plaintext}
          </code>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => copy(safe.plaintext)}
              className="btn-primary text-xs"
            >
              {copied ? "Copied!" : "Copy token"}
            </button>
            <span className="text-[11px] text-ink-500">
              Preview <code className="font-mono">{safe.tokenPreview}…</code>
            </span>
          </div>
          <p className="text-[11px] text-ink-700 leading-relaxed">
            Configure your assistant with this token via the
            Authorization header: <code className="font-mono">Bearer &lt;token&gt;</code>.
            See <code className="font-mono">docs/mcp-server/claude-code-config.md</code>.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-xs" disabled={pending}>
      {pending ? "Creating…" : "Create token"}
    </button>
  );
}
