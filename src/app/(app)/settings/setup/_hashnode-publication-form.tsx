"use client";

import { useState } from "react";

/**
 * Per-identity Hashnode publication-id form.
 *
 * Posts to POST /api/identity/[id]/hashnode/publication. The
 * publication_id is operator-visible (Hashnode's UI shows it in
 * publication settings); we don't treat it as a secret. The API key
 * is set elsewhere — this form never reads or writes it.
 */
export function HashnodePublicationForm({
  identityId,
  identityHandle,
  initialPublicationId,
}: {
  identityId: string;
  identityHandle: string;
  initialPublicationId: string | null;
}) {
  const [publicationId, setPublicationId] = useState(initialPublicationId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/identity/${encodeURIComponent(identityId)}/hashnode/publication`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publication_id: publicationId.trim() }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        publication_id?: string;
      };
      if (res.ok && body.ok) {
        setMessage({
          kind: "ok",
          text: `Saved. The scheduler will publish to publication ${body.publication_id ?? publicationId.trim()}.`,
        });
      } else {
        setMessage({
          kind: "error",
          text: body.error ?? `Request failed with HTTP ${res.status}.`,
        });
      }
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-2">
      <label
        htmlFor={`pubid-${identityId}`}
        className="block text-[11px] font-semibold uppercase tracking-wide text-ink-500"
      >
        Publication id for @{identityHandle}
      </label>
      <div className="flex flex-wrap items-stretch gap-2">
        <input
          id={`pubid-${identityId}`}
          type="text"
          value={publicationId}
          onChange={(e) => setPublicationId(e.target.value)}
          placeholder="e.g. 6453a1b2c3d4e5f6a7b8c9d0"
          autoComplete="off"
          spellCheck={false}
          className="min-w-[260px] flex-1 rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono text-ink-800 focus:outline-none focus:ring-2 focus:ring-signal-500"
        />
        <button
          type="submit"
          className="btn whitespace-nowrap"
          disabled={
            submitting || publicationId.trim().length === 0
          }
        >
          {submitting ? "Saving…" : "Save publication id"}
        </button>
      </div>
      {message ? (
        <p
          className={`text-xs ${
            message.kind === "ok" ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {message.text}
        </p>
      ) : null}
      <p className="text-[11px] text-ink-500 leading-relaxed">
        Find this on hashnode.com → your blog dashboard → Publication
        Settings → &quot;Publication ID&quot;. The value is opaque (looks
        like a hex string) and visible in your Hashnode admin UI.
      </p>
    </form>
  );
}
