import Link from "next/link";
import { ChevronRightIcon } from "./icons";

export type ExplainTone = "info" | "warn" | "block" | "ok";

export interface ExplainProps {
  tone?: ExplainTone;
  label: string;
  shortReason: string;
  detailedReasons?: string[];
  recommendation?: string;
  relatedEntity?: { label: string; value: string };
  link?: { href: string; label: string };
}

const toneStyles: Record<ExplainTone, { border: string; bg: string; dot: string }> = {
  info: {
    border: "border-signal-200",
    bg: "bg-signal-50/40",
    dot: "bg-signal-500",
  },
  warn: {
    border: "border-amber-200",
    bg: "bg-amber-50/50",
    dot: "bg-amber-500",
  },
  block: {
    border: "border-red-200",
    bg: "bg-red-50/50",
    dot: "bg-red-600",
  },
  ok: {
    border: "border-emerald-200",
    bg: "bg-emerald-50/40",
    dot: "bg-emerald-500",
  },
};

export function Explain({
  tone = "info",
  label,
  shortReason,
  detailedReasons,
  recommendation,
  relatedEntity,
  link,
}: ExplainProps) {
  const t = toneStyles[tone];
  return (
    <div
      className={`card ${t.border} ${t.bg} p-4 text-sm leading-relaxed space-y-2`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${t.dot}`} />
        <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-600">
          {label}
        </span>
      </div>
      <div className="text-ink-900 font-medium">{shortReason}</div>
      {detailedReasons && detailedReasons.length > 0 ? (
        <ul className="text-ink-700 space-y-0.5">
          {detailedReasons.map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      ) : null}
      {recommendation ? (
        <div className="text-ink-800 italic">{recommendation}</div>
      ) : null}
      {relatedEntity || link ? (
        <div className="flex items-center justify-between text-xs text-ink-500 pt-1">
          {relatedEntity ? (
            <span>
              {relatedEntity.label}:{" "}
              <span className="text-ink-700">{relatedEntity.value}</span>
            </span>
          ) : (
            <span />
          )}
          {link ? (
            <Link
              href={link.href}
              className="text-signal-700 hover:text-signal-800 inline-flex items-center gap-1"
            >
              {link.label}
              <ChevronRightIcon width={12} height={12} />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WhyRiskBadge(props: Omit<ExplainProps, "label">) {
  return <Explain {...props} label="Why this risk" tone={props.tone ?? "warn"} />;
}

export function WhySkipped(props: Omit<ExplainProps, "label">) {
  return <Explain {...props} label="Why skipped" tone={props.tone ?? "info"} />;
}

export function WhyBacklogged(props: Omit<ExplainProps, "label">) {
  return <Explain {...props} label="Why backlogged" tone={props.tone ?? "info"} />;
}

export function WhyScheduledHere(props: Omit<ExplainProps, "label">) {
  return (
    <Explain {...props} label="Why this slot" tone={props.tone ?? "info"} />
  );
}

export function WhyOpportunity(props: Omit<ExplainProps, "label">) {
  return (
    <Explain {...props} label="Why this opportunity" tone={props.tone ?? "info"} />
  );
}

export function WhyAccountIneligible(props: Omit<ExplainProps, "label">) {
  return (
    <Explain {...props} label="Why not eligible" tone={props.tone ?? "warn"} />
  );
}

export function WhyContentBlocked(props: Omit<ExplainProps, "label">) {
  return (
    <Explain {...props} label="Why blocked" tone={props.tone ?? "block"} />
  );
}

export function WhyDiscoverabilityOpportunity(
  props: Omit<ExplainProps, "label">,
) {
  return (
    <Explain
      {...props}
      label="Why this discoverability move"
      tone={props.tone ?? "info"}
    />
  );
}
