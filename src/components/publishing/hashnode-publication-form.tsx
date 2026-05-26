"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Per-identity Hashnode publication-id form.
 *
 * Used in two places:
 *   1. The /accounts identity card's Manage panel (primary, where
 *      Hashnode setup completes alongside the API-key sign-in).
 *   2. The /settings/setup page (backup discovery surface).
 *
 * Posts to `POST /api/identity/[id]/hashnode/publication`. The route
 * encrypts nothing — `publication_id` is operator-visible by design
 * (Hashnode renders it in publication settings) and is stored on
 * `platform_connections.metadata.publication_id`. We never touch
 * the API key on this surface.
 *
 * After a successful save the form calls `router.refresh()` so the
 * server component re-resolves identity publish state — a Hashnode
 * identity that was `connected_incomplete` flips to `connected`
 * on the next render without the operator manually reloading.
 */
export function HashnodePublicationForm({
  identityId,
  identityHandle,
  initialPublicationId,
  variant = "default",
}: {
  identityId: string;
  identityHandle: string;
  initialPublicationId: string | null;
  /**
   * Visual variant. `default` is the verbose Setup-page shape;
   * `compact` is the tighter Manage-panel shape that drops the
   * sub-label and operator help line so the form fits in the
   * identity card. The submitted endpoint + behavior are identical.
   */
  variant?: "default" | "compact";
}) {
  const [publicationId, setPublicationId] = useState(initialPublicationId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);
  const router = useRouter();

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
        // Re-run the server component so the resolver picks up the
        // new metadata.publication_id and the pill flips from
        // "Finish setup" → "Signed in". Without this, the operator
        // would see a stale "Finish setup" badge until the next
        // navigation.
        router.refresh();
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

  const isCompact = variant === "compact";

  return (
    <form
      onSubmit={handleSubmit}
      className={isCompact ? "space-y-2" : "mt-3 space-y-2"}
    >
      {!isCompact ? (
        <label
          htmlFor={`pubid-${identityId}`}
          className="block text-[11px] font-semibold uppercase tracking-wide text-ink-500"
        >
          Publication id for @{identityHandle}
        </label>
      ) : (
        <label
          htmlFor={`pubid-${identityId}`}
          className="block text-[10px] font-medium text-ink-600"
        >
          Hashnode publication id
        </label>
      )}
      <div className="flex flex-wrap items-stretch gap-2">
        <input
          id={`pubid-${identityId}`}
          type="text"
          value={publicationId}
          onChange={(e) => setPublicationId(e.target.value)}
          placeholder="e.g. 6453a1b2c3d4e5f6a7b8c9d0"
          autoComplete="off"
          spellCheck={false}
          className={
            isCompact
              ? "min-w-[200px] flex-1 rounded border border-ink-200 bg-white px-2 py-1 text-[11px] font-mono text-ink-800 focus:outline-none focus:ring-2 focus:ring-signal-500"
              : "min-w-[260px] flex-1 rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-mono text-ink-800 focus:outline-none focus:ring-2 focus:ring-signal-500"
          }
        />
        <button
          type="submit"
          className={isCompact ? "btn-primary text-[11px] whitespace-nowrap" : "btn whitespace-nowrap"}
          disabled={submitting || publicationId.trim().length === 0}
        >
          {submitting
            ? "Saving…"
            : initialPublicationId
              ? "Update"
              : "Save publication id"}
        </button>
      </div>
      {message ? (
        <p
          className={
            isCompact
              ? `text-[10px] ${
                  message.kind === "ok" ? "text-emerald-700" : "text-rose-700"
                }`
              : `text-xs ${
                  message.kind === "ok" ? "text-emerald-700" : "text-rose-700"
                }`
          }
        >
          {message.text}
        </p>
      ) : null}
      {!isCompact ? (
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Find this on hashnode.com → your blog dashboard → Publication
          Settings → &quot;Publication ID&quot;. The value is opaque (looks
          like a hex string) and visible in your Hashnode admin UI.
        </p>
      ) : (
        <p className="text-[10px] text-ink-500 leading-relaxed">
          hashnode.com → blog dashboard → Publication Settings →
          &quot;Publication ID&quot;.
        </p>
      )}
    </form>
  );
}
