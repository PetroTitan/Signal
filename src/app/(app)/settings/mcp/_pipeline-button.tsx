"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  runVerificationPipelineAction,
  type PipelineActionResult,
} from "./_actions";

const initial: PipelineActionResult = { ok: false, error: "" };

const VERDICT_CLASS: Record<string, string> = {
  ready_to_merge: "text-green-700",
  needs_review: "text-amber-700",
  blocked: "text-red-700",
};

const VERDICT_LABEL: Record<string, string> = {
  ready_to_merge: "Ready to merge",
  needs_review: "Needs review",
  blocked: "Blocked",
};

const STATUS_CLASS: Record<string, string> = {
  pass: "text-green-700",
  warning: "text-amber-700",
  fail: "text-red-700",
};

export function VerificationPipelineButton() {
  const [state, formAction] = useFormState(
    runVerificationPipelineAction,
    initial,
  );
  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Full verification pipeline
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Runs every check end-to-end: env, auth, RLS, DB integrity, route
            protection, demo boundary, production smoke, and the full
            execution dry-run (with cleanup). Produces a single PR-readiness
            verdict.
          </p>
        </div>
        <form action={formAction}>
          <Submit />
        </form>
      </div>

      {safe.ok ? <PipelineReport state={safe} /> : null}
      {!safe.ok && safe.error ? (
        <p className="text-xs text-red-700">{safe.error}</p>
      ) : null}
    </section>
  );
}

function PipelineReport({
  state,
}: {
  state: Extract<PipelineActionResult, { ok: true }>;
}) {
  return (
    <div className="space-y-3 mt-2">
      <div className="flex items-center justify-between text-xs text-ink-600">
        <div>
          Verdict:{" "}
          <span
            className={`font-medium ${
              VERDICT_CLASS[state.verdict] ?? "text-ink-700"
            }`}
          >
            {VERDICT_LABEL[state.verdict] ?? state.verdict}
          </span>
        </div>
        <div>
          {state.durationMs}ms · run {state.runId.slice(0, 8)} · verification{" "}
          {state.verificationRunId.slice(0, 8)}
        </div>
      </div>
      <ul className="row-divider border border-ink-100 rounded-md overflow-hidden">
        {state.results.map((r) => (
          <li key={r.check} className="px-3 py-2 text-xs bg-white">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-800">{r.label}</span>
              <span className={STATUS_CLASS[r.status] ?? "text-ink-600"}>
                {r.status}
              </span>
            </div>
            <div className="text-ink-500 mt-0.5">{r.summary}</div>
            {r.details.length > 0 ? (
              <ul className="text-ink-400 text-[11px] mt-1 list-disc list-inside space-y-0.5">
                {r.details.slice(0, 8).map((d, idx) => (
                  <li key={idx} className="break-words">
                    {d}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-primary text-xs whitespace-nowrap"
      disabled={pending}
    >
      {pending ? "Running…" : "Run full verification pipeline"}
    </button>
  );
}
