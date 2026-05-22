import Link from "next/link";
import { Topbar } from "@/components/topbar";
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

export const dynamic = "force-dynamic";

export default function McpSettingsPage() {
  const operations = MCP_OPERATION_TYPES.map(summarizeOperation);

  return (
    <>
      <Topbar
        title="MCP operations"
        description="What Claude, Codex, and MCP-connected tools may do in Signal — and what stays gated."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Operating model</h2>
          <ol className="mt-3 list-decimal list-inside space-y-1 text-sm text-ink-700">
            <li>AI inspects the workspace, schema, and types.</li>
            <li>AI prepares a draft proposal — code, mapping, or migration.</li>
            <li>AI runs local checks (lint / typecheck / build, smoke tests).</li>
            <li>AI shows a report.</li>
            <li>You review and approve, reject, or request changes.</li>
            <li>AI applies only the approved action.</li>
            <li>Signal logs the operation in <code className="font-mono text-xs">mcp_operation_runs</code> and <code className="font-mono text-xs">activity_events</code>.</li>
          </ol>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">No approval needed</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {MCP_POLICY_ALLOWED_NO_APPROVAL.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Requires your approval</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {MCP_POLICY_REQUIRES_APPROVAL.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">Always blocked</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {MCP_POLICY_BLOCKED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card overflow-x-auto">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">Operations table</div>
            <p className="text-xs text-ink-500 mt-0.5">
              Every operation Claude / Codex may attempt is enumerated here.
              The runner refuses anything outside this list.
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

        <section className="card p-5 text-xs text-ink-600 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-1">MCP status</div>
          MCP-connected tools must implement this contract to interact with
          the operations layer. Configuration of the MCP server is a deploy-time
          concern — Signal does not embed an MCP client. Use{" "}
          <Link href="/imports" className="text-signal-700 underline">
            /imports
          </Link>{" "}
          for the import assistant.
        </section>
      </div>
    </>
  );
}
