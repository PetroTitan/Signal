/**
 * The advisory strip, shared by the weekly plan and the compose sheet.
 *
 * This component is the milestone's boundary made visible: it appears
 * next to controls that publish, approve and schedule, and it must never
 * become part of them. So it renders text and one link. No button, no
 * checkbox, no acknowledgement, no disabled state, and nothing that
 * changes what the surrounding form will accept.
 *
 * NEUTRAL BY CONSTRUCTION. It carries no severity colour, because a hint
 * that "you have never opened with a question" is not a warning and
 * styling it as one would make the operator feel corrected by a tool
 * that has, in most workspaces, measured nothing at all.
 *
 * A caller with nothing to show renders nothing — never an empty box
 * saying "no recommendations", which would read as a finding.
 */

import Link from "next/link";

export interface StrategyHint {
  id: string;
  title: string;
  rationale: string;
}

export function StrategyHints({
  hints,
  heading = "Ideas from your own history",
  className,
}: {
  hints: readonly StrategyHint[];
  heading?: string;
  className?: string;
}) {
  if (hints.length === 0) return null;

  return (
    <section
      className={`rounded-lg border border-ink-200 bg-ink-50/40 p-3 ${className ?? ""}`}
      aria-label={heading}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[11px] uppercase tracking-wide text-ink-500">{heading}</h3>
        <Link href="/strategy" className="text-[11px] text-ink-500 underline">
          See the evidence
        </Link>
      </div>
      <ul className="list-none p-0 m-0 mt-2 space-y-2">
        {hints.map((hint) => (
          <li key={hint.id} className="text-sm text-ink-700 leading-relaxed min-w-0">
            <span className="break-words">{hint.title}</span>
            <span className="block text-[11px] text-ink-500 mt-0.5 break-words">
              {hint.rationale}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-400 mt-2 leading-relaxed">
        Optional. Nothing here is required, and ignoring it changes nothing about
        what you can write, approve or schedule.
      </p>
    </section>
  );
}
