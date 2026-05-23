/**
 * Phase F2.9.7 — calm founder inbox.
 *
 * Each item is a single human sentence telling the operator what
 * needs attention. No raw enums, no policy codes. The parent server
 * page resolves the sentences from execution_logs + publish_history
 * + plan items.
 */

import Link from "next/link";

export type NeedsAttentionSeverity = "info" | "warn" | "danger";

export interface NeedsAttentionEntry {
  id: string;
  /** Single founder-readable sentence. */
  message: string;
  /** Optional deep link to the surface where this gets resolved. */
  href: string | null;
  /** Optional CTA label, e.g. "Open post" / "Reconnect Reddit". */
  cta?: string | null;
  severity: NeedsAttentionSeverity;
}

const TONE: Record<
  NeedsAttentionSeverity,
  { border: string; dot: string }
> = {
  info: { border: "border-signal-100", dot: "bg-signal-500" },
  warn: { border: "border-amber-100", dot: "bg-amber-500" },
  danger: { border: "border-red-100", dot: "bg-red-500" },
};

export function NeedsAttentionStrip({
  entries,
}: {
  entries: NeedsAttentionEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-ink-900">Needs attention</h2>
        <span className="text-[11px] text-ink-500">
          {entries.length} item{entries.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-1.5">
        {entries.map((e) => {
          const tone = TONE[e.severity];
          return (
            <li
              key={e.id}
              className={`flex items-start gap-2 rounded-md bg-white border ${tone.border} px-3 py-2`}
            >
              <span
                className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${tone.dot}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-800 leading-relaxed">
                  {e.message}
                </p>
              </div>
              {e.href ? (
                <Link
                  href={e.href}
                  className="text-[11px] text-ink-700 underline shrink-0 whitespace-nowrap"
                >
                  {e.cta ?? "Open"} →
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
