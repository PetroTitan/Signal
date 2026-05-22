"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  runSupabaseProbeAction,
  type SupabaseProbeActionResult,
} from "./_actions";

const initial: SupabaseProbeActionResult = { ok: false, error: "" };

const STATUS_CLASS: Record<string, string> = {
  healthy: "text-green-700",
  degraded: "text-amber-700",
  failed: "text-red-700",
};

const VERDICT_CLASS: Record<string, string> = {
  verified: "text-green-700",
  missing: "text-red-700",
  not_tested: "text-ink-500",
};

const MODE_HINT: Record<string, string> = {
  internal_db_probe:
    "Internal DB probe — Signal verified the data plane through its own authenticated session. Not the same as a direct MCP connection.",
  operator_bridge:
    "Operator bridge — the operator's assistant ran the probe and posted the result back.",
  direct_mcp: "Direct MCP — Signal called the MCP connector itself.",
};

interface InitialState {
  /** Latest persisted probe (from the server component). Used for the
   *  pre-run summary so the card always renders something useful. */
  latestStatus: "healthy" | "degraded" | "failed" | "unknown" | null;
  latestMode: "internal_db_probe" | "operator_bridge" | "direct_mcp" | null;
  latestCheckedAt: string | null;
  latestSummary: string;
  latestCapabilities: Record<string, "verified" | "missing" | "not_tested"> | null;
  latestEvidence: Record<string, unknown> | null;
}

export function SupabaseProbeCard(props: InitialState) {
  const [state, formAction] = useFormState(runSupabaseProbeAction, initial);
  const safe = state ?? initial;

  // Prefer the just-run result; fall back to the persisted one.
  const status = safe.ok ? safe.status : props.latestStatus;
  const mode = safe.ok ? safe.mode : props.latestMode;
  const capabilities = safe.ok ? safe.capabilities : props.latestCapabilities;
  const evidence = safe.ok ? safe.evidence : props.latestEvidence;
  const checkedAt = safe.ok ? new Date().toISOString() : props.latestCheckedAt;

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Supabase MCP probe
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Verifies the Supabase data plane through Signal&apos;s own
            authenticated session. The probe is read-only, runs five
            capability checks, and never uses the service-role key.
          </p>
        </div>
        <form action={formAction}>
          <Submit />
        </form>
      </div>

      {status ? (
        <div className="text-xs text-ink-600">
          Status:{" "}
          <span className={`font-medium ${STATUS_CLASS[status] ?? "text-ink-700"}`}>
            {status === "healthy" && mode === "internal_db_probe"
              ? "DB probe healthy"
              : status === "degraded" && mode === "internal_db_probe"
              ? "DB probe degraded"
              : status === "failed" && mode === "internal_db_probe"
              ? "DB probe failed"
              : status}
          </span>
          {checkedAt ? (
            <span className="text-ink-400">
              {" "}
              · checked {checkedAt.slice(0, 19).replace("T", " ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {mode ? (
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Mode: <code className="font-mono">{mode}</code>. {MODE_HINT[mode]}
        </p>
      ) : null}

      {capabilities ? (
        <ul className="text-xs text-ink-700 space-y-0.5">
          {Object.entries(capabilities).map(([cap, verdict]) => (
            <li key={cap} className="flex justify-between gap-3">
              <span className="font-mono text-[11px]">{cap}</span>
              <span className={VERDICT_CLASS[verdict] ?? "text-ink-500"}>
                {verdict}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {evidence ? <EvidenceList evidence={evidence} /> : null}

      {!safe.ok && safe.error ? (
        <p className="text-xs text-red-700">{safe.error}</p>
      ) : null}

      {safe.ok ? (
        <p className="text-[10px] text-ink-500">
          Probe <code className="font-mono">{safe.probeId.slice(0, 8)}</code>{" "}
          recorded; mcp_operation_runs row{" "}
          <code className="font-mono">{safe.operationRunId.slice(0, 8)}</code>.
        </p>
      ) : null}
    </section>
  );
}

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const required = Number(evidence.required_table_count ?? 0);
  const present = Number(evidence.table_count ?? 0);
  const missing = (evidence.required_tables_missing as string[] | undefined) ?? [];
  const warnings = (evidence.warnings as string[] | undefined) ?? [];
  return (
    <div className="text-[11px] text-ink-500 leading-relaxed border-t border-ink-100 pt-2 space-y-1">
      <div>
        Tables present: {present}/{required}
        {missing.length > 0 ? ` · missing: ${missing.join(", ")}` : null}
      </div>
      {warnings.length > 0 ? (
        <ul className="list-disc list-inside space-y-0.5">
          {warnings.slice(0, 5).map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      ) : null}
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
      {pending ? "Probing…" : "Run Supabase probe"}
    </button>
  );
}
