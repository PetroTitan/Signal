"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createOperatorBridgeRequestAction,
  type CreateBridgeResult,
} from "./_actions";

const initial: CreateBridgeResult = { ok: false, error: "" };

const ASSISTANTS = [
  { value: "claude_code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "claude_opus", label: "Claude Opus" },
  { value: "supabase_mcp", label: "Supabase MCP" },
  { value: "github_mcp", label: "GitHub MCP" },
  { value: "vercel_manual", label: "Vercel (manual)" },
];

const REQUEST_TYPES = [
  { value: "repo_check", label: "Repository check" },
  { value: "db_check", label: "Database check" },
  { value: "rls_check", label: "RLS check" },
  { value: "migration_review", label: "Migration review" },
  { value: "pr_readiness_review", label: "PR readiness review" },
  { value: "import_mapping", label: "Import mapping" },
  { value: "smoke_test", label: "Smoke test" },
  { value: "deployment_review", label: "Deployment review" },
  { value: "architecture_audit", label: "Architecture audit" },
];

const RISK_LEVELS = [
  { value: "safe_read", label: "Safe read" },
  { value: "local_write", label: "Local write" },
  { value: "remote_write", label: "Remote write" },
  { value: "production_impacting", label: "Production impacting" },
];

export function CreateBridgeRequestForm() {
  const [state, formAction] = useFormState(
    createOperatorBridgeRequestAction,
    initial,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">
        Create a bridge request
      </h2>
      <p className="text-xs text-ink-600 leading-relaxed">
        Sends a structured task to the operator&apos;s assistant. Signal
        records the request in <code className="font-mono text-[11px]">operator_bridge_requests</code>{" "}
        and links a fresh <code className="font-mono text-[11px]">mcp_operation_runs</code>{" "}
        row.
      </p>

      <form ref={formRef} action={formAction} className="space-y-3 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block md:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Title
            </div>
            <input
              type="text"
              name="title"
              required
              className="input w-full"
              placeholder="What should the assistant do?"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Assistant
            </div>
            <select name="assistant_type" defaultValue="claude_code" className="input w-full">
              {ASSISTANTS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Request type
            </div>
            <select name="request_type" defaultValue="repo_check" className="input w-full">
              {REQUEST_TYPES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Risk level
            </div>
            <select name="risk_level" defaultValue="safe_read" className="input w-full">
              {RISK_LEVELS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Task prompt
          </div>
          <textarea
            name="task_prompt"
            rows={5}
            className="input w-full font-mono text-xs"
            required
            placeholder="Describe what the assistant should verify. Be specific. Do not ask the assistant to mutate anything."
          />
        </label>

        <div className="flex items-center gap-3">
          <Submit />
          {safe.ok ? (
            <span className="text-[11px] text-ink-600">
              Request <code className="font-mono">{safe.requestId.slice(0, 8)}</code>{" "}
              created. Open it to copy the prompt.
            </span>
          ) : safe.error ? (
            <span className="text-[11px] text-red-700">{safe.error}</span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-xs" disabled={pending}>
      {pending ? "Creating…" : "Create bridge request"}
    </button>
  );
}
