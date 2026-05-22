import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  listPendingApprovals,
  listRecentOperationRuns,
} from "@/repositories/admin-operations/mcp-operation-repository";
import {
  APPROVAL_MODE_LABELS,
  MCP_OPERATION_LABELS,
  MCP_OPERATION_TYPES,
  MCP_POLICY_ALLOWED_NO_APPROVAL,
  MCP_POLICY_BLOCKED,
  MCP_POLICY_REQUIRES_APPROVAL,
  RISK_LEVEL_LABELS,
  summarizeOperation,
} from "@/core/mcp-operations";
import {
  ASSISTANT_LABELS,
  RUNTIME_CONNECTOR_STATUS_HINTS,
  RUNTIME_CONNECTOR_STATUS_LABELS,
  RUNTIME_CAPABILITY_LABELS,
  buildDefaultConnectorSnapshots,
} from "@/core/mcp-runtime";
import { MCP_CHECKS } from "./_check-catalog";
import { RunCheckButton } from "./_run-check-button";
import { ApproveButton, RejectForm } from "./_approval-controls";
import { VerificationPipelineButton } from "./_pipeline-button";

export const dynamic = "force-dynamic";

export default async function McpSettingsPage() {
  const supabaseReady = isSupabaseConfigured();
  let membership = null;
  let runs: Awaited<ReturnType<typeof listRecentOperationRuns>> = [];
  let pending: Awaited<ReturnType<typeof listPendingApprovals>> = [];

  if (supabaseReady) {
    membership = await getPrimaryWorkspace();
    if (membership) {
      [runs, pending] = await Promise.all([
        listRecentOperationRuns(membership.workspace.id, 20),
        listPendingApprovals(membership.workspace.id, 20),
      ]);
    }
  }

  const operations = MCP_OPERATION_TYPES.map(summarizeOperation);
  const connectorSnapshots = buildDefaultConnectorSnapshots(new Date().toISOString());

  return (
    <>
      <Topbar
        title="MCP Operations"
        description="Use connected AI assistants to inspect, validate, prepare, and report. Production-impacting actions require approval."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        {/* PART 2 — STATUS PANEL */}
        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Runtime status
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Signal does not run an MCP client itself. Each row shows what
              capabilities Signal expects the connector to support and the
              honest connection state — never &ldquo;Connected&rdquo; without
              verification.
            </p>
          </header>
          <ul className="row-divider">
            {connectorSnapshots.map((c) => (
              <li
                key={c.kind}
                className="px-5 py-3 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-ink-900">
                    {ASSISTANT_LABELS[c.kind]}
                  </div>
                  <div className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                    {c.note}
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">
                    {RUNTIME_CONNECTOR_STATUS_HINTS[c.status]}
                  </div>
                  <div className="text-[10px] text-ink-400 mt-1">
                    Capabilities:{" "}
                    {c.capabilities
                      .map((cap) => RUNTIME_CAPABILITY_LABELS[cap])
                      .join(", ")}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="badge-neutral text-[10px] whitespace-nowrap">
                    {RUNTIME_CONNECTOR_STATUS_LABELS[c.status]}
                  </span>
                  {c.lastCheckedAt ? (
                    <div className="text-[10px] text-ink-400 mt-1">
                      Checked {c.lastCheckedAt.slice(0, 19).replace("T", " ")}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* PHASE E2.5 — VERIFICATION PIPELINE */}
        <VerificationPipelineButton />

        {/* PART 3 — CHECK RUNNER */}
        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Check runner
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Read-only diagnostics. Each entry shows the risk level Signal
              treats it as.
            </p>
          </header>
          <ul className="row-divider">
            {MCP_CHECKS.map((check) => {
              const perm = check.operationType
                ? summarizeOperation(check.operationType)
                : null;
              return (
                <li
                  key={check.key}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-ink-900">{check.label}</div>
                    <div className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                      {check.description}
                    </div>
                    <div className="text-[11px] text-ink-400 mt-1 flex flex-wrap gap-2">
                      {perm ? (
                        <>
                          <span>Risk: {RISK_LEVEL_LABELS[perm.riskLevel]}</span>
                          <span>·</span>
                          <span>
                            Approval: {APPROVAL_MODE_LABELS[perm.approvalMode]}
                          </span>
                        </>
                      ) : (
                        <span>Risk: documentation only</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <RunCheckButton
                      checkKey={check.key}
                      wired={check.wired}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* PART 6 — PENDING APPROVALS */}
        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Pending MCP approvals
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Operations in <code className="font-mono text-[11px]">pending_approval</code>{" "}
              that need a human decision before running.
            </p>
          </header>
          {!supabaseReady ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Supabase is not configured. Configure env vars to surface the
              approvals queue.
            </div>
          ) : !membership ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No workspace yet. Create one before reviewing operations.
            </div>
          ) : pending.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Nothing waiting for approval right now.
            </div>
          ) : (
            <ul className="row-divider">
              {pending.map((run) => (
                <li key={run.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-ink-900">
                        {MCP_OPERATION_LABELS[
                          run.operationType as keyof typeof MCP_OPERATION_LABELS
                        ] ?? run.operationType}
                      </div>
                      <div className="text-[11px] text-ink-500 mt-0.5">
                        {RISK_LEVEL_LABELS[
                          run.riskLevel as keyof typeof RISK_LEVEL_LABELS
                        ] ?? run.riskLevel}
                        {" · "}
                        {APPROVAL_MODE_LABELS[
                          run.approvalMode as keyof typeof APPROVAL_MODE_LABELS
                        ] ?? run.approvalMode}
                      </div>
                      {run.inputSummary ? (
                        <div className="text-[11px] text-ink-700 mt-1 line-clamp-2">
                          {run.inputSummary}
                        </div>
                      ) : null}
                      <div className="text-[11px] text-ink-400 mt-1">
                        Created {run.createdAt}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <ApproveButton runId={run.id} approvalMode={run.approvalMode} />
                    <RejectForm runId={run.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* PART 4 — OPERATION RUN HISTORY */}
        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Operation runs
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Audit trail of MCP-driven operations on this workspace.
            </p>
          </header>
          {!supabaseReady ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Supabase is not configured.
            </div>
          ) : !membership ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No workspace yet.
            </div>
          ) : runs.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No MCP operations yet. Run a check or prepare an assisted import
              when MCP tools are connected.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-ink-50 text-ink-500 text-[10px] uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Operation</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Risk</th>
                  <th className="text-left px-4 py-2">Approval</th>
                  <th className="text-left px-4 py-2">Created</th>
                  <th className="text-left px-4 py-2">Approved</th>
                  <th className="text-left px-4 py-2">Result</th>
                </tr>
              </thead>
              <tbody className="row-divider">
                {runs.map((run) => (
                  <tr key={run.id} className="align-top">
                    <td className="px-4 py-2 text-ink-800">
                      {MCP_OPERATION_LABELS[
                        run.operationType as keyof typeof MCP_OPERATION_LABELS
                      ] ?? run.operationType}
                    </td>
                    <td className="px-4 py-2 text-ink-700">{run.status}</td>
                    <td className="px-4 py-2 text-ink-700">
                      {RISK_LEVEL_LABELS[
                        run.riskLevel as keyof typeof RISK_LEVEL_LABELS
                      ] ?? run.riskLevel}
                    </td>
                    <td className="px-4 py-2 text-ink-700">
                      {APPROVAL_MODE_LABELS[
                        run.approvalMode as keyof typeof APPROVAL_MODE_LABELS
                      ] ?? run.approvalMode}
                    </td>
                    <td className="px-4 py-2 text-ink-500">{run.createdAt}</td>
                    <td className="px-4 py-2 text-ink-500">
                      {run.approvedAt ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-700">
                      {run.errorSummary ? (
                        <span className="text-red-700">
                          {run.errorSummary}
                        </span>
                      ) : (
                        run.outputSummary ?? "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* PART 5 — APPROVAL MODEL */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Approval model</h2>
          <ul className="mt-3 text-sm text-ink-700 space-y-2">
            <li className="flex gap-3">
              <span className="badge-neutral text-[10px] mt-0.5">Safe read</span>
              <span>No approval needed.</span>
            </li>
            <li className="flex gap-3">
              <span className="badge-neutral text-[10px] mt-0.5">Local write</span>
              <span>Approval recommended.</span>
            </li>
            <li className="flex gap-3">
              <span className="badge-neutral text-[10px] mt-0.5">Remote write</span>
              <span>Approval required.</span>
            </li>
            <li className="flex gap-3">
              <span className="badge-neutral text-[10px] mt-0.5">
                Production impacting
              </span>
              <span>Explicit text confirmation required.</span>
            </li>
            <li className="flex gap-3">
              <span className="badge-neutral text-[10px] mt-0.5">Blocked</span>
              <span>Never allowed.</span>
            </li>
          </ul>
        </section>

        {/* PART 8 — SAFETY BOUNDARIES */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Safety boundaries
          </h2>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-ink-700">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Allowed without approval
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {MCP_POLICY_ALLOWED_NO_APPROVAL.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Requires approval
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {MCP_POLICY_REQUIRES_APPROVAL.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Always blocked
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {MCP_POLICY_BLOCKED.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* PART 7 — IMPORT ASSISTANT CTA */}
        <section className="card p-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">
              Import assistant
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              Map screenshots and pasted product copy into structured product
              and account fields. The extractor never stores raw screenshots
              by default and refuses fields on the never-extract list.
            </p>
          </div>
          <Link href="/imports" className="btn-primary text-xs whitespace-nowrap">
            Open import assistant
          </Link>
        </section>

        {/* OPERATIONS TABLE (REFERENCE) */}
        <section className="card overflow-x-auto">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Operations reference
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Every operation type the runner recognizes. The runner refuses
              anything outside this list.
            </p>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5">Operation</th>
                <th className="text-left px-4 py-2.5">Risk</th>
                <th className="text-left px-4 py-2.5">Approval</th>
                <th className="text-left px-4 py-2.5">Reversible</th>
                <th className="text-left px-4 py-2.5">Production</th>
              </tr>
            </thead>
            <tbody className="row-divider">
              {operations.map((op) => (
                <tr key={op.operationType}>
                  <td className="px-4 py-2 text-ink-800">
                    {MCP_OPERATION_LABELS[op.operationType]}
                  </td>
                  <td className="px-4 py-2 text-ink-700">
                    {RISK_LEVEL_LABELS[op.riskLevel]}
                  </td>
                  <td className="px-4 py-2 text-ink-700">
                    {APPROVAL_MODE_LABELS[op.approvalMode]}
                  </td>
                  <td className="px-4 py-2 text-ink-700">
                    {op.reversible ? "yes" : "no"}
                  </td>
                  <td className="px-4 py-2 text-ink-700">
                    {op.touchesProduction ? "yes" : "no"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="text-[11px] text-ink-500 leading-relaxed">
          MCP configuration is a deploy-time concern; Signal does not embed an
          MCP client. See <code className="font-mono">docs/mcp/</code> for the
          full operating policy.
        </section>
      </div>
    </>
  );
}
