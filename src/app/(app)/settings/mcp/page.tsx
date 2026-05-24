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
import { SupabaseProbeCard } from "./_supabase-probe-card";
import { getLatestProbe } from "@/repositories/mcp-connectors/supabase-mcp-probe-repository";
import { TOOLS, BLOCKED_TOOL_NAMES } from "@/mcp/tool-registry";
import { isServiceRoleAvailable } from "@/lib/supabase/service-role";
import { listRecentToolCalls } from "@/mcp/audit";
import { listOperatorTokens } from "@/repositories/mcp-server/operator-token-repository";
import { deriveTokenState, relativeTime } from "@/mcp/token-state";

export const dynamic = "force-dynamic";

export default async function McpSettingsPage() {
  const supabaseReady = isSupabaseConfigured();
  let membership = null;
  let runs: Awaited<ReturnType<typeof listRecentOperationRuns>> = [];
  let pending: Awaited<ReturnType<typeof listPendingApprovals>> = [];
  let latestSupabaseProbe: Awaited<ReturnType<typeof getLatestProbe>> = null;
  let tokens: Awaited<ReturnType<typeof listOperatorTokens>> = [];

  if (supabaseReady) {
    membership = await getPrimaryWorkspace();
    if (membership) {
      [runs, pending, latestSupabaseProbe, tokens] = await Promise.all([
        listRecentOperationRuns(membership.workspace.id, 20),
        listPendingApprovals(membership.workspace.id, 20),
        getLatestProbe({
          workspaceId: membership.workspace.id,
          connectorType: "supabase_mcp",
        }),
        listOperatorTokens(membership.workspace.id),
      ]);
    }
  }

  const operations = MCP_OPERATION_TYPES.map(summarizeOperation);
  const connectorSnapshots = buildDefaultConnectorSnapshots(
    new Date().toISOString(),
  );
  const serviceRoleAvailable = isServiceRoleAvailable();
  const recentToolCalls = membership
    ? await listRecentToolCalls(membership.workspace.id, 12)
    : [];
  const blockedToolCallCount = recentToolCalls.filter(
    (c) => c.status === "blocked" || c.status === "unauthorized",
  ).length;
  const enabledToolGroups = {
    read: TOOLS.filter((t) => !t.writesDatabase).length,
    prepare: TOOLS.filter((t) => t.writesDatabase).length,
    blocked: BLOCKED_TOOL_NAMES.size,
  };

  const activeTokens = tokens.filter((t) => {
    const kind = deriveTokenState(t).kind;
    return kind !== "revoked" && kind !== "expired";
  });
  const everConnectedToken = tokens.find((t) => t.lastUsedAt);
  const lastUsedRelative = everConnectedToken
    ? relativeTime(everConnectedToken.lastUsedAt)
    : null;

  return (
    <>
      <Topbar
        title="MCP"
        description="Connect Claude Code, Codex, or another MCP client to this workspace. Publishing still requires your approval."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-5">
        {/* ASSISTANT ACCESS — primary founder CTA */}
        <section className="rounded-2xl border border-ink-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-ink-900">
                Assistant access
              </h2>
              <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                Create a token to let Claude Code, Codex, or another MCP
                client read this workspace and prepare drafts. You approve
                everything before it publishes.
              </p>
              <div className="mt-2 text-[11px] text-ink-500">
                {activeTokens.length} active token
                {activeTokens.length === 1 ? "" : "s"}
                {lastUsedRelative ? (
                  <> · Last used {lastUsedRelative}</>
                ) : tokens.length > 0 ? (
                  <> · No assistant has connected yet</>
                ) : null}
              </div>
            </div>
            <Link
              href="/settings/mcp/tokens"
              className="btn-primary text-xs whitespace-nowrap"
            >
              {tokens.length === 0
                ? "Connect an assistant"
                : "Manage tokens"}
            </Link>
          </div>
        </section>

        {/* PENDING APPROVALS — only if any */}
        {pending.length > 0 ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/40">
            <header className="px-5 py-3.5 border-b border-amber-100">
              <div className="text-sm font-semibold text-amber-900">
                Waiting for your approval ({pending.length})
              </div>
              <p className="text-[11px] text-amber-900/80 mt-0.5">
                The assistant prepared these operations. Nothing runs until
                you approve.
              </p>
            </header>
            <ul className="row-divider">
              {pending.map((run) => (
                <li key={run.id} className="px-5 py-3">
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
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <ApproveButton
                      runId={run.id}
                      approvalMode={run.approvalMode}
                    />
                    <RejectForm runId={run.id} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* RECENT ASSISTANT ACTIVITY */}
        <section className="rounded-2xl border border-ink-200 bg-white">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-baseline justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Recent assistant activity
              </div>
              <p className="text-[11px] text-ink-500 mt-0.5">
                Real tool calls recorded against this workspace.
                {blockedToolCallCount > 0
                  ? ` ${blockedToolCallCount} blocked or unauthorized in the last ${recentToolCalls.length}.`
                  : ""}
              </p>
            </div>
            {recentToolCalls.length > 0 ? (
              <div className="text-[11px] text-ink-400 shrink-0">
                Last {recentToolCalls.length}
              </div>
            ) : null}
          </header>
          {!supabaseReady ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Persistence not configured.
            </div>
          ) : !membership ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No workspace yet.
            </div>
          ) : recentToolCalls.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No assistant activity yet. After you issue a token and the
              assistant connects, the calls land here.
            </div>
          ) : (
            <ul className="row-divider">
              {recentToolCalls.slice(0, 8).map((c) => (
                <li
                  key={c.id}
                  className="px-5 py-2.5 flex items-baseline justify-between gap-3"
                >
                  <code className="font-mono text-[11px] text-ink-800 truncate min-w-0">
                    {c.tool_name}
                  </code>
                  <span
                    className={`text-[11px] shrink-0 ${
                      c.status === "completed"
                        ? "text-emerald-700"
                        : c.status === "blocked" || c.status === "unauthorized"
                          ? "text-red-700"
                          : "text-ink-500"
                    }`}
                  >
                    {c.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* OPERATION RUN HISTORY */}
        {runs.length > 0 ? (
          <section className="rounded-2xl border border-ink-200 bg-white">
            <header className="px-5 py-3.5 border-b border-ink-100">
              <div className="text-sm font-semibold text-ink-900">
                Operation history
              </div>
              <p className="text-[11px] text-ink-500 mt-0.5">
                Audit trail of MCP-driven operations on this workspace.
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-ink-50 text-ink-500 text-[10px] uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-2">Operation</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Risk</th>
                    <th className="text-left px-4 py-2">Created</th>
                    <th className="text-left px-4 py-2">Result</th>
                  </tr>
                </thead>
                <tbody className="row-divider">
                  {runs.slice(0, 10).map((run) => (
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
                      <td className="px-4 py-2 text-ink-500 whitespace-nowrap">
                        {run.createdAt.slice(0, 10)}
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
            </div>
          </section>
        ) : null}

        {/* TRUST MODEL — what assistants can / can't do */}
        <section className="rounded-2xl border border-ink-200 bg-white p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">
              What assistants can and can&apos;t do
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              The boundaries below are enforced by Signal regardless of which
              MCP client connects.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-ink-700">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">
                Allowed without approval
              </div>
              <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
                {MCP_POLICY_ALLOWED_NO_APPROVAL.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1">
                Requires your approval
              </div>
              <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
                {MCP_POLICY_REQUIRES_APPROVAL.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="md:col-span-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-red-700 mb-1">
                Always blocked
              </div>
              <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
                {MCP_POLICY_BLOCKED.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* DEVELOPER DIAGNOSTICS — collapsed by default */}
        <details className="rounded-2xl border border-ink-200 bg-white">
          <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
            Developer diagnostics
            <span className="ml-2 text-[11px] font-normal text-ink-500">
              probes, RLS, smoke tests, runtime state — not part of the
              founder workflow
            </span>
          </summary>

          <div className="border-t border-ink-100 px-5 py-5 space-y-5">
            <section>
              <div className="text-sm font-semibold text-ink-900">
                Runtime status
              </div>
              <p className="text-xs text-ink-500 mt-0.5 leading-relaxed">
                Signal does not run an MCP client itself. Each row shows what
                capabilities Signal expects the connector to support and the
                honest connection state — never &ldquo;Connected&rdquo;
                without verification.
              </p>
              <ul className="row-divider mt-2 rounded-md border border-ink-100">
                {connectorSnapshots.map((c) => (
                  <li
                    key={c.kind}
                    className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap"
                  >
                    <div className="min-w-0 flex-1">
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
                    <span className="text-[10px] rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-ink-600 whitespace-nowrap shrink-0">
                      {RUNTIME_CONNECTOR_STATUS_LABELS[c.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-md border border-ink-100 p-4 space-y-2">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  Signal MCP server
                </div>
                <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                  External operators connect to{" "}
                  <code className="font-mono text-[11px]">/api/mcp</code>{" "}
                  with a workspace-scoped bearer token. Signal serves the
                  audited tool surface; the operator&apos;s assistant remains
                  the agent.
                </p>
              </div>
              <p className="text-[11px] text-ink-500">
                Server status:{" "}
                <span
                  className={
                    serviceRoleAvailable
                      ? "text-emerald-700"
                      : "text-amber-700"
                  }
                >
                  {serviceRoleAvailable ? "available" : "not configured"}
                </span>
                {" · "}
                {enabledToolGroups.read} read · {enabledToolGroups.prepare}{" "}
                prepare · {enabledToolGroups.blocked} explicitly blocked
              </p>
              {!serviceRoleAvailable ? (
                <p className="text-[11px] text-amber-700">
                  Set{" "}
                  <code className="font-mono">
                    SUPABASE_SERVICE_ROLE_KEY
                  </code>{" "}
                  server-side to enable the MCP HTTP bridge. Until then the
                  route returns 503 for every call.
                </p>
              ) : null}
            </section>

            <section>
              <div className="text-sm font-semibold text-ink-900 mb-2">
                Supabase MCP probe
              </div>
              <SupabaseProbeCard
                latestStatus={
                  (latestSupabaseProbe?.healthStatus as
                    | "healthy"
                    | "degraded"
                    | "failed"
                    | "unknown"
                    | null) ?? null
                }
                latestMode={
                  (latestSupabaseProbe?.mode as
                    | "internal_db_probe"
                    | "operator_bridge"
                    | "direct_mcp"
                    | null) ?? null
                }
                latestCheckedAt={latestSupabaseProbe?.completedAt ?? null}
                latestSummary={latestSupabaseProbe?.errorSummary ?? ""}
                latestCapabilities={
                  (latestSupabaseProbe?.capabilityResults as Record<
                    string,
                    "verified" | "missing" | "not_tested"
                  > | null) ?? null
                }
                latestEvidence={latestSupabaseProbe?.evidence ?? null}
              />
            </section>

            <section>
              <div className="text-sm font-semibold text-ink-900 mb-2">
                Verification pipeline
              </div>
              <VerificationPipelineButton />
            </section>

            <section>
              <div className="text-sm font-semibold text-ink-900">
                Check runner
              </div>
              <p className="text-xs text-ink-500 mt-0.5 leading-relaxed">
                Read-only diagnostics. Each entry shows the risk level Signal
                treats it as.
              </p>
              <ul className="row-divider mt-2 rounded-md border border-ink-100">
                {MCP_CHECKS.map((check) => {
                  const perm = check.operationType
                    ? summarizeOperation(check.operationType)
                    : null;
                  return (
                    <li
                      key={check.key}
                      className="px-4 py-3 flex items-start justify-between gap-4 flex-wrap"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-ink-900">
                          {check.label}
                        </div>
                        <div className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                          {check.description}
                        </div>
                        <div className="text-[11px] text-ink-400 mt-1 flex flex-wrap gap-2">
                          {perm ? (
                            <>
                              <span>
                                Risk: {RISK_LEVEL_LABELS[perm.riskLevel]}
                              </span>
                              <span>·</span>
                              <span>
                                Approval:{" "}
                                {APPROVAL_MODE_LABELS[perm.approvalMode]}
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

            <section className="rounded-md border border-ink-100 p-4 flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink-900">
                  Operator bridge
                </div>
                <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                  Send a structured task to Claude Code / Codex / Opus and
                  paste the signed result back. Used when the assistant runs
                  outside Signal — Signal verifies the nonce + schema and
                  stores the audit row.
                </p>
              </div>
              <Link
                href="/operator-bridge"
                className="btn-ghost text-xs whitespace-nowrap"
              >
                Open
              </Link>
            </section>

            <section>
              <div className="text-sm font-semibold text-ink-900">
                Operations reference
              </div>
              <p className="text-xs text-ink-500 mt-0.5 leading-relaxed">
                Every operation type the runner recognizes. The runner
                refuses anything outside this list.
              </p>
              <div className="mt-2 overflow-x-auto rounded-md border border-ink-100">
                <table className="w-full text-xs">
                  <thead className="bg-ink-50 text-ink-500 text-[10px] uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-2">Operation</th>
                      <th className="text-left px-3 py-2">Risk</th>
                      <th className="text-left px-3 py-2">Approval</th>
                      <th className="text-left px-3 py-2">Reversible</th>
                      <th className="text-left px-3 py-2">Production</th>
                    </tr>
                  </thead>
                  <tbody className="row-divider">
                    {operations.map((op) => (
                      <tr key={op.operationType}>
                        <td className="px-3 py-2 text-ink-800">
                          {MCP_OPERATION_LABELS[op.operationType]}
                        </td>
                        <td className="px-3 py-2 text-ink-700">
                          {RISK_LEVEL_LABELS[op.riskLevel]}
                        </td>
                        <td className="px-3 py-2 text-ink-700">
                          {APPROVAL_MODE_LABELS[op.approvalMode]}
                        </td>
                        <td className="px-3 py-2 text-ink-700">
                          {op.reversible ? "yes" : "no"}
                        </td>
                        <td className="px-3 py-2 text-ink-700">
                          {op.touchesProduction ? "yes" : "no"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="text-[11px] text-ink-500 leading-relaxed">
              MCP configuration is a deploy-time concern; Signal does not
              embed an MCP client. See{" "}
              <code className="font-mono">docs/mcp/</code> for the full
              operating policy.
            </p>
          </div>
        </details>
      </div>
    </>
  );
}
