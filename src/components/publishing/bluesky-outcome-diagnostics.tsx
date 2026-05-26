/**
 * Operator-facing diagnostics panel for a Bluesky publish attempt.
 *
 * Receives a `BlueskyOutcomeSummary` (pure-derived from the
 * execution_items row, the latest execution_logs row, and the
 * plan_item's creatives) and renders a compact panel that shows:
 *
 *   - Overall outcome status (badge + reason_code).
 *   - reason_detail copy (the human-readable reason).
 *   - The published permalink, when present.
 *   - Bluesky-specific diagnostics (media_attached, endpoint,
 *     http_status, atproto_error/message, redacted response body,
 *     thread shape, DID, root_uri, creative_id).
 *   - Source-of-truth label per field (which DB column it came
 *     from), so the operator can tell whether a value is observed
 *     or inferred.
 *   - Divergence warning when the operator approved a creative but
 *     the publish completed without media.
 *   - Transformation notes from the deterministic copy adapter
 *     (re-derived; not persisted in the DB).
 *
 * Server component — receives a `summary` prop and renders.
 * No client state, no fetches. Designed to be embedded inside the
 * existing `/execution/items/[id]` server page.
 *
 * Safety: never renders access tokens, refresh tokens, Authorization
 * headers, or app passwords. The atproto_response_body field on the
 * summary is already redacted twice (upstream in the publisher and
 * defensively in the summary builder). The component does NOT
 * re-render `metadata` blobs unless behind an explicit details
 * disclosure.
 */

import React from "react";
import type {
  BlueskyOutcomeSummary,
  FieldSource,
  FieldWithSource,
  MediaAttached,
  OutcomeStatus,
} from "@/core/publishing/bluesky-outcome-summary";

export interface BlueskyOutcomeDiagnosticsProps {
  summary: BlueskyOutcomeSummary;
}

// ---------------------------------------------------------------------
// Status badge tones
// ---------------------------------------------------------------------

const STATUS_CHIP: Record<
  OutcomeStatus,
  { label: string; cls: string }
> = {
  published: {
    label: "Published",
    cls: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
  failed: {
    label: "Failed",
    cls: "bg-red-50 text-red-800 border-red-200",
  },
  blocked: {
    label: "Blocked",
    cls: "bg-amber-50 text-amber-800 border-amber-200",
  },
  scheduled: {
    label: "Scheduled",
    cls: "bg-signal-50 text-signal-700 border-signal-200",
  },
  in_flight: {
    label: "In flight",
    cls: "bg-signal-50 text-signal-700 border-signal-200",
  },
  skipped: {
    label: "Skipped",
    cls: "bg-ink-50 text-ink-700 border-ink-200",
  },
  unknown: {
    label: "Unknown",
    cls: "bg-ink-50 text-ink-700 border-ink-200",
  },
};

const MEDIA_CHIP: Record<
  MediaAttached,
  { label: string; cls: string; icon: string }
> = {
  yes: {
    label: "Image attached",
    cls: "bg-emerald-50 text-emerald-800 border-emerald-200",
    icon: "✓",
  },
  no: {
    label: "Text-only",
    cls: "bg-ink-50 text-ink-700 border-ink-200",
    icon: "·",
  },
  unknown: {
    label: "Media status not recorded",
    cls: "bg-amber-50 text-amber-800 border-amber-200",
    icon: "?",
  },
};

// ---------------------------------------------------------------------
// Source-of-truth label
// ---------------------------------------------------------------------

const SOURCE_LABEL: Record<FieldSource, string> = {
  execution_item: "execution_items.metadata.publish_outcome",
  execution_log: "execution_logs.metadata",
  preview_rederivation: "deterministic adapter re-derived",
  absent: "not recorded",
};

/**
 * One-line "source: ..." label rendered next to each value. Compact
 * + monospace so the operator can scan it without it competing with
 * the actual content.
 */
function SourceTag({ source }: { source: FieldSource }) {
  return (
    <span
      className="text-[10px] font-mono text-ink-400"
      title={SOURCE_LABEL[source]}
    >
      source: {SOURCE_LABEL[source]}
    </span>
  );
}

/** Helper: skip rendering a field when its source is "absent" AND
 *  it's optional (so the operator isn't told about every missing
 *  AT Proto field on a successful publish). */
function hasValue<T>(f: FieldWithSource<T | null>): f is FieldWithSource<T> {
  return f.value !== null && f.value !== undefined;
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

export function BlueskyOutcomeDiagnostics({
  summary,
}: BlueskyOutcomeDiagnosticsProps) {
  const status = summary.status.value;
  const chip = STATUS_CHIP[status];
  const media = MEDIA_CHIP[summary.mediaAttached.value];

  return (
    <section
      aria-label="Bluesky publish diagnostics"
      className="rounded-2xl border border-ink-200 bg-white overflow-hidden"
    >
      {/* Header — status + reason_code chip + external link */}
      <header className="px-5 py-4 border-b border-ink-100 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-500">
          Bluesky publish
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${chip.cls}`}
        >
          {chip.label}
        </span>
        {hasValue(summary.reasonCode) ? (
          <span className="inline-flex items-center rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-mono text-ink-700">
            {summary.reasonCode.value}
          </span>
        ) : null}
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${media.cls}`}
        >
          <span aria-hidden>{media.icon}</span>
          <span>{media.label}</span>
        </span>
        {hasValue(summary.externalUrl) ? (
          <a
            href={summary.externalUrl.value}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs text-signal-700 underline break-all"
          >
            {summary.externalUrl.value} ↗
          </a>
        ) : null}
      </header>

      {/* Divergence warning — always shown when present, prominent. */}
      {summary.divergence ? (
        <div className="px-5 py-3 border-b border-ink-100 bg-amber-50/60">
          <div className="flex items-start gap-2">
            <span aria-hidden className="text-amber-700">
              ⚠
            </span>
            <p className="text-[12px] text-amber-900 leading-relaxed">
              {summary.divergence.message}
            </p>
          </div>
        </div>
      ) : null}

      {/* Reason detail — human-readable */}
      {hasValue(summary.reasonDetail) ? (
        <div className="px-5 py-3 border-b border-ink-100">
          <p className="text-[12px] text-ink-800 leading-relaxed">
            {summary.reasonDetail.value}
          </p>
          <p className="text-[10px] text-ink-400 font-mono mt-1">
            source: {SOURCE_LABEL[summary.reasonDetail.source]}
          </p>
        </div>
      ) : null}

      {/* Diagnostic grid — Bluesky-specific fields */}
      <dl className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-[12px]">
        {hasValue(summary.endpoint) ? (
          <Field
            label="Endpoint"
            value={
              <span className="font-mono text-ink-800">
                com.atproto.repo.{summary.endpoint.value}
              </span>
            }
            source={summary.endpoint.source}
          />
        ) : null}
        {hasValue(summary.httpStatus) ? (
          <Field
            label="HTTP status"
            value={
              <span className="font-mono text-ink-800">
                {summary.httpStatus.value}
              </span>
            }
            source={summary.httpStatus.source}
          />
        ) : null}
        {hasValue(summary.atprotoError) ? (
          <Field
            label="AT Proto error"
            value={
              <span className="font-mono text-ink-800">
                {summary.atprotoError.value}
              </span>
            }
            source={summary.atprotoError.source}
          />
        ) : null}
        {hasValue(summary.atprotoMessage) ? (
          <Field
            label="AT Proto message"
            value={
              <span className="text-ink-800">
                {summary.atprotoMessage.value}
              </span>
            }
            source={summary.atprotoMessage.source}
          />
        ) : null}
        {hasValue(summary.threadLength) ? (
          <Field
            label="Thread length"
            value={
              <span className="text-ink-800">
                {summary.threadLength.value} part
                {summary.threadLength.value === 1 ? "" : "s"}
              </span>
            }
            source={summary.threadLength.source}
          />
        ) : null}
        {hasValue(summary.threadPositionFailed) &&
        hasValue(summary.threadLength) ? (
          <Field
            label="Failed on part"
            value={
              <span className="text-ink-800">
                {summary.threadPositionFailed.value} of {summary.threadLength.value}
              </span>
            }
            source={summary.threadPositionFailed.source}
          />
        ) : null}
        {hasValue(summary.did) ? (
          <Field
            label="Identity DID"
            value={
              <span className="font-mono text-ink-800 break-all">
                {summary.did.value}
              </span>
            }
            source={summary.did.source}
          />
        ) : null}
        {hasValue(summary.creativeId) ? (
          <Field
            label="Creative id"
            value={
              <span className="font-mono text-ink-800">
                {summary.creativeId.value}
              </span>
            }
            source={summary.creativeId.source}
          />
        ) : null}
        <Field
          label="Media attached"
          value={
            <span className="text-ink-800">{media.label}</span>
          }
          source={summary.mediaAttached.source}
        />
      </dl>

      {/* AT Proto response body — behind disclosure */}
      {hasValue(summary.atprotoResponseBody) ? (
        <details className="px-5 py-3 border-t border-ink-100">
          <summary className="cursor-pointer text-[11px] text-ink-600 hover:text-ink-900">
            AT Proto response body (redacted)
          </summary>
          <pre className="mt-2 text-[11px] bg-ink-50 border border-ink-100 rounded p-2 overflow-x-auto font-mono">
            {summary.atprotoResponseBody.value}
          </pre>
          <p className="text-[10px] text-ink-400 font-mono mt-1">
            source: {SOURCE_LABEL[summary.atprotoResponseBody.source]}
          </p>
        </details>
      ) : null}

      {/* Transformation notes — re-derived from the body */}
      {summary.transformationNotes.value.length > 0 ? (
        <div className="px-5 py-3 border-t border-ink-100 bg-ink-50/40">
          <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-1.5">
            Adapter applied
          </div>
          <ul className="text-[12px] text-ink-800 space-y-0.5">
            {summary.transformationNotes.value.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
          <p className="text-[10px] text-ink-400 font-mono mt-1.5">
            source: {SOURCE_LABEL[summary.transformationNotes.source]}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Field({
  label,
  value,
  source,
}: {
  label: string;
  value: React.ReactNode;
  source: FieldSource;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-500">
        {label}
      </dt>
      <dd className="text-ink-800 mt-0.5 min-w-0 break-words">{value}</dd>
      <div className="mt-0.5">
        <SourceTag source={source} />
      </div>
    </div>
  );
}
