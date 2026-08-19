import type { HealthSignal, Recommendation, SignalState } from "@/core/intelligence";

/**
 * Presentational pieces of the account-health page, split out so they can
 * be rendered in a test. The page itself is an async server component
 * that needs a database, but these are pure and are where the honesty
 * rules actually show up in pixels.
 */

const STATE_LABEL: Record<SignalState, string> = {
  normal: "Normal",
  advisory: "Worth attention",
  insufficient_data: "Not enough data",
  unavailable: "Unavailable",
  stale: "Stale",
  rate_limited: "Rate limited",
  provider_error: "Provider error",
};

/** Deliberately not a red/green scale — none of these is a failure. */
const STATE_BADGE: Record<SignalState, string> = {
  normal: "badge badge-neutral",
  advisory: "badge badge-medium",
  insufficient_data: "badge badge-info",
  unavailable: "badge badge-info",
  stale: "badge badge-medium",
  rate_limited: "badge badge-medium",
  provider_error: "badge badge-high",
};

const URGENCY_LABEL: Record<Recommendation["urgency"], string> = {
  now: "Do this first",
  soon: "Soon",
  when_convenient: "When convenient",
  informational: "For information",
};

export function SignalCard({ signal }: { signal: HealthSignal }) {
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label">{signal.label}</span>
        <span className={STATE_BADGE[signal.state]}>{STATE_LABEL[signal.state]}</span>
      </div>
      {signal.value ? (
        <p className="stat-value mt-1 break-words">{signal.value}</p>
      ) : null}
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">{signal.evidence}</p>
      <p className="text-[11px] text-ink-400 mt-1.5">
        {signal.timeframe} · source: {signal.source} · confidence: {signal.confidence}
      </p>
    </li>
  );
}


export function RecommendationRow({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="badge badge-info">{URGENCY_LABEL[recommendation.urgency]}</span>
        <p className="text-sm text-ink-900 font-medium leading-relaxed min-w-0">
          {recommendation.action}
        </p>
      </div>
      <p className="text-sm text-ink-600 leading-relaxed">{recommendation.rationale}</p>
    </div>
  );
}

export { STATE_LABEL, STATE_BADGE, URGENCY_LABEL };
