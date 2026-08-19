import type { EvidenceItem, Confidence } from "@/core/strategy/evidence";
import type { StrategyOption } from "@/core/strategy/recommendations";
import type { ExperimentSuggestion } from "@/core/strategy/experiments";
import type { PairDifferentiation } from "@/core/strategy/differentiation";
import type { MixDimension } from "@/core/strategy/content-mix";
import type { DimensionPerformance } from "@/core/strategy/performance";

/**
 * Presentational pieces of the strategy page, split out so they can be
 * rendered in a test. The page is an async server component that needs a
 * database; these are pure, and they are where the advisory posture
 * actually shows up in pixels.
 *
 * THE RULES THAT LIVE HERE
 *   - no option renders a disabled control, a warning colour, or a
 *     required acknowledgement
 *   - every option shows its evidence and its confidence, always
 *     visible rather than behind a disclosure
 *   - a category label ("Suggestion", "Observation") is never omitted,
 *     because the operator's trust depends on knowing which is which
 *   - nothing here submits a form or mutates anything
 */

const CATEGORY_LABEL: Record<EvidenceItem["category"], string> = {
  fact: "Fact",
  observation: "Observation",
  suggestion: "Suggestion",
  experiment: "Experiment",
  ai_interpretation: "AI interpretation",
};

/**
 * Deliberately not a severity scale. An untested option is not a
 * problem, and colouring it amber would make it read as one.
 */
const CATEGORY_BADGE: Record<EvidenceItem["category"], string> = {
  fact: "badge badge-neutral",
  observation: "badge badge-info",
  suggestion: "badge badge-info",
  experiment: "badge badge-info",
  ai_interpretation: "badge badge-info",
};

/**
 * These name the strength of the EVIDENCE, not the strength of the
 * advice. Rendering "Strong signal" beside a suggestion read, in a real
 * browser check, as "strongly recommended" — which is the one thing this
 * layer must never say.
 */
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  strong: "Directly measured",
  moderate: "Moderate evidence",
  weak: "Weak evidence",
  none: "No performance data",
};

const KIND_LABEL: Record<StrategyOption["kind"], string> = {
  explore: "Untested",
  exploit: "Repeat what worked",
  differentiate: "Differentiate",
  resume: "Dormant topic",
  cold_start: "Starting point",
};

export function EvidenceList({ evidence }: { evidence: readonly EvidenceItem[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="list-none p-0 m-0 mt-2 space-y-1.5">
      {evidence.map((item, index) => (
        <li key={`${item.category}-${index}`} className="text-sm text-ink-600 leading-relaxed">
          <span className="text-[11px] uppercase tracking-wide text-ink-400 mr-1.5">
            {CATEGORY_LABEL[item.category]}
          </span>
          <span className="break-words">{item.statement}</span>
          <span className="block text-[11px] text-ink-400 mt-0.5 break-words">
            source: {item.source}
            {item.timeframe ? ` · ${item.timeframe}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OptionCard({ option }: { option: StrategyOption }) {
  return (
    <li className="row-divider py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-ink-900 min-w-0 break-words">
          {option.title}
        </h3>
        <span className="badge badge-neutral">{KIND_LABEL[option.kind]}</span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed break-words">
        {option.rationale}
      </p>
      <EvidenceList evidence={option.evidence} />
      {option.experimentIntent ? (
        <p className="text-[11px] text-ink-500 mt-2 leading-relaxed">
          What it would tell you: {option.experimentIntent}
        </p>
      ) : null}
      <p className="text-[11px] text-ink-400 mt-1.5">
        {CONFIDENCE_LABEL[option.confidence]}
        {option.platform ? ` · ${option.platform}` : ""}
      </p>
    </li>
  );
}

export function MixRow({ dimension }: { dimension: MixDimension<string> }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label">{dimension.dimension}</span>
        <span className="text-[11px] text-ink-400">
          {dimension.usesPercentages ? "percentages" : "counts only — sample too small for percentages"}
        </span>
      </div>
      <ul className="list-none p-0 m-0 space-y-1">
        {dimension.entries.map((entry) => (
          <li
            key={entry.value}
            className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-ink-700"
          >
            <span className="min-w-0 break-words">{entry.label}</span>
            <span className="tabular-nums text-ink-900">
              {entry.percent != null ? `${entry.percent}% (${entry.count})` : entry.count}
            </span>
          </li>
        ))}
      </ul>
      {dimension.entries.length === 0 ? (
        <p className="text-sm text-ink-500">Nothing to describe yet.</p>
      ) : null}
    </div>
  );
}

export function PerformanceRow({ entry }: { entry: DimensionPerformance }) {
  return (
    <li className="row-divider py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label min-w-0 break-words">{entry.label}</span>
        <span className="text-[11px] text-ink-400 tabular-nums">n = {entry.n}</span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed break-words">
        {entry.statement}
      </p>
    </li>
  );
}

export function PairRow({ pair }: { pair: PairDifferentiation }) {
  return (
    <li className="row-divider py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="stat-label min-w-0 break-words">
          {pair.platforms[0]} ↔ {pair.platforms[1]}
        </span>
        <span className="text-[11px] text-ink-400 tabular-nums">
          {pair.messagePercent}% shared wording
        </span>
      </div>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed">
        Same: {pair.same.length > 0 ? pair.same.join(", ") : "nothing structural"}.
        {" "}
        Different: {pair.different.length > 0 ? pair.different.join(", ") : "nothing structural"}.
      </p>
      {pair.minutesApart != null ? (
        <p className="text-[11px] text-ink-400 mt-1">
          Published {pair.minutesApart} minute(s) apart.
        </p>
      ) : null}
      {pair.suggestion ? (
        <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
          <span className="text-[11px] uppercase tracking-wide text-ink-400 mr-1.5">
            Suggestion
          </span>
          {pair.suggestion}
        </p>
      ) : null}
    </li>
  );
}

export function ExperimentCard({ experiment }: { experiment: ExperimentSuggestion }) {
  return (
    <li className="row-divider py-4 first:pt-0 last:pb-0">
      <h3 className="text-sm font-medium text-ink-900 break-words">{experiment.title}</h3>
      <p className="text-sm text-ink-600 mt-1 leading-relaxed break-words">
        {experiment.question}
      </p>
      <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
        {experiment.readout}
      </p>
      <ul className="list-none p-0 m-0 mt-2 space-y-0.5">
        {experiment.arms.map((arm) => (
          <li key={arm.label} className="text-[11px] text-ink-500 tabular-nums break-words">
            {arm.label}: {arm.postsSoFar} post(s) so far
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-400 mt-2 leading-relaxed break-words">
        {experiment.limitation}
      </p>
    </li>
  );
}

/**
 * The AI section, when there is one. Labelled unmistakably, and rendered
 * BELOW the deterministic evidence so the page reads the same way the
 * pipeline runs.
 */
export function InterpretationBlock({
  text,
  note,
}: {
  text: string | null;
  note: string | null;
}) {
  return (
    <section className="card card-padded">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="section-title">Interpretation</h2>
        <span className="badge badge-info">AI interpretation</span>
      </div>
      {text ? (
        <p className="text-sm text-ink-600 mt-2 leading-relaxed whitespace-pre-line break-words">
          {text}
        </p>
      ) : null}
      {note ? <p className="text-[11px] text-ink-400 mt-2 leading-relaxed">{note}</p> : null}
      <p className="text-[11px] text-ink-400 mt-2 leading-relaxed">
        Written by a model from the evidence above. It cannot introduce a number
        that is not already on this page, and everything above it is computed
        without any model.
      </p>
    </section>
  );
}

export { CATEGORY_LABEL, CATEGORY_BADGE, CONFIDENCE_LABEL, KIND_LABEL };
