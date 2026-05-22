"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  approveOperationRun,
  closeOperationRun,
  openOperationRun,
  rejectOperationRun,
} from "@/repositories/admin-operations/mcp-operation-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import {
  runFullVerificationPipeline,
  runSingleCheck,
} from "@/repositories/verification";
import type {
  CheckResult,
  PrReadinessVerdict,
} from "@/core/verification";

export type ApproveResult = ActionResult<{ runId: string }>;
export type RejectResult = ActionResult<{ runId: string }>;
export type RunCheckResult = ActionResult<{
  runId: string;
  checkOk: boolean;
  notes: string[];
}>;
export type PipelineActionResult = ActionResult<{
  runId: string;
  verificationRunId: string;
  verdict: PrReadinessVerdict;
  results: CheckResult[];
  durationMs: number;
}>;
export type SupabaseProbeActionResult = ActionResult<{
  probeId: string;
  operationRunId: string;
  status: "healthy" | "degraded" | "failed";
  mode: "internal_db_probe" | "operator_bridge" | "direct_mcp";
  capabilities: Record<string, "verified" | "missing" | "not_tested">;
  evidence: Record<string, unknown>;
}>;

export async function runSupabaseProbeAction(
  _prev: SupabaseProbeActionResult,
  _formData: FormData,
): Promise<SupabaseProbeActionResult> {
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const { runSupabaseDataPlaneProbe } = await import(
      "@/repositories/mcp-connectors/supabase-mcp-connector"
    );
    const {
      completeProbe,
      failProbe,
      openProbe,
    } = await import(
      "@/repositories/mcp-connectors/supabase-mcp-probe-repository"
    );
    const { recordActivity } = await import(
      "@/repositories/activity-repository"
    );

    const operationRun = await openOperationRun({
      workspaceId,
      operationType: "smoke_test_run",
      initialStatus: "running",
      inputSummary: "Phase E2.7 — Supabase MCP connector probe (internal_db_probe)",
    });
    const probe = await openProbe({
      workspaceId,
      connectorType: "supabase_mcp",
      mode: "internal_db_probe",
    });

    try {
      const result = await runSupabaseDataPlaneProbe({ workspaceId });
      await completeProbe({
        workspaceId,
        probeId: probe.id,
        result,
      });
      await closeOperationRun({
        workspaceId,
        runId: operationRun.id,
        status: result.status === "failed" ? "failed" : "completed",
        outputSummary: `mode=${result.mode}; status=${result.status}; ${Object.entries(
          result.capabilities,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join("; ")}`,
        metadata: {
          probe_id: probe.id,
          mode: result.mode,
          health: result.status,
          evidence: result.evidence,
        },
      });
      try {
        await recordActivity({
          workspaceId,
          eventType: "mcp.supabase_probe_completed",
          entityType: "mcp_connector_probe",
          entityId: probe.id,
          title: `Supabase probe ${result.status}`,
          description: `mode=${result.mode}; ${result.evidence.required_tables_missing.length} missing table(s).`,
          metadata: { probe_id: probe.id, operation_run_id: operationRun.id },
        });
      } catch (err) {
        console.error("[supabase-probe] activity log failed", err);
      }
      revalidatePath("/settings/mcp");
      revalidatePath("/activity");
      return actionOk({
        probeId: probe.id,
        operationRunId: operationRun.id,
        status: result.status,
        mode: result.mode,
        capabilities: result.capabilities as Record<
          string,
          "verified" | "missing" | "not_tested"
        >,
        evidence: result.evidence as unknown as Record<string, unknown>,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Probe failed.";
      await failProbe({
        workspaceId,
        probeId: probe.id,
        errorSummary: message,
      }).catch(() => {});
      await closeOperationRun({
        workspaceId,
        runId: operationRun.id,
        status: "failed",
        errorSummary: message,
      }).catch(() => {});
      try {
        await recordActivity({
          workspaceId,
          eventType: "mcp.supabase_probe_failed",
          entityType: "mcp_connector_probe",
          entityId: probe.id,
          title: "Supabase probe failed",
          description: message,
          metadata: { probe_id: probe.id, operation_run_id: operationRun.id },
        });
      } catch (logErr) {
        console.error("[supabase-probe] activity log failed", logErr);
      }
      return actionFail(message);
    }
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Probe failed.",
    );
  }
}

export async function approveMcpOperationAction(
  _prev: ApproveResult,
  formData: FormData,
): Promise<ApproveResult> {
  const runId = String(formData.get("run_id") ?? "").trim();
  const phrase = String(formData.get("confirmation_phrase") ?? "").trim();
  if (!runId) return actionFail("Missing run id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return actionFail("Not authenticated.");

    // Load the run to check whether explicit-text confirmation is
    // required. We can't trust the client to declare the approval mode
    // — read it from the DB.
    const { getOperationRunById } = await import(
      "@/repositories/admin-operations/mcp-operation-repository"
    );
    const existing = await getOperationRunById(membership.workspace.id, runId);
    if (existing.approvalMode === "explicit_text_confirmation_required") {
      const { productionApprovalPhrase } = await import("@/core/mcp-runtime");
      const expected = productionApprovalPhrase(runId);
      if (phrase !== expected) {
        return actionFail(
          `This operation requires an explicit confirmation phrase. Type: "${expected}"`,
        );
      }
    }
    if (existing.approvalMode === "blocked") {
      return actionFail("This operation is hard-blocked and cannot be approved.");
    }

    const run = await approveOperationRun({
      workspaceId: membership.workspace.id,
      runId,
      approvedBy: user.id,
    });
    revalidatePath("/settings/mcp");
    revalidatePath("/activity");
    return actionOk({ runId: run.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Approve failed.",
    );
  }
}

export async function rejectMcpOperationAction(
  _prev: RejectResult,
  formData: FormData,
): Promise<RejectResult> {
  const runId = String(formData.get("run_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || undefined;
  if (!runId) return actionFail("Missing run id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const run = await rejectOperationRun({
      workspaceId: membership.workspace.id,
      runId,
      reason,
    });
    revalidatePath("/settings/mcp");
    revalidatePath("/activity");
    return actionOk({ runId: run.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Reject failed.",
    );
  }
}

/**
 * Runs a safe, read-only check end-to-end. Only operations marked
 * `no_approval_needed` may be invoked from this action — anything
 * higher-risk lands in pending_approval and is gated by the approve /
 * reject UI.
 */
export async function runMcpCheckAction(
  _prev: RunCheckResult,
  formData: FormData,
): Promise<RunCheckResult> {
  const operationType = String(formData.get("operation_type") ?? "").trim();
  if (!operationType) return actionFail("Missing operation type.");

  const ALLOWED = new Set([
    "smoke_test_run",
    "env_check",
    "auth_check",
    "rls_check",
    "db_integrity_check",
    "route_protection_check",
    "demo_boundary_check",
    "oauth_safety_check",
    "execution_safety_check",
    "weekly_contract_check",
    "supabase_mcp_probe_check",
    "execution_dry_run_smoke",
    "production_smoke_test",
  ]);
  if (!ALLOWED.has(operationType)) {
    return actionFail(
      `The "${operationType}" check is prepared but not connected yet.`,
    );
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const run = await openOperationRun({
      workspaceId,
      operationType: "smoke_test_run",
      initialStatus: "running",
      inputSummary: `Manual run: ${operationType}`,
    });

    const checkKey =
      operationType === "smoke_test_run"
        ? "production_smoke_test"
        : (operationType as
            | "env_check"
            | "auth_check"
            | "rls_check"
            | "db_integrity_check"
            | "route_protection_check"
            | "demo_boundary_check"
            | "oauth_safety_check"
            | "execution_safety_check"
            | "weekly_contract_check"
            | "supabase_mcp_probe_check"
            | "execution_dry_run_smoke"
            | "production_smoke_test");

    const result = await runSingleCheck(checkKey);
    const ok = result.status === "pass" || result.status === "warning";

    await closeOperationRun({
      workspaceId,
      runId: run.id,
      status: result.status === "fail" ? "failed" : "completed",
      outputSummary: result.summary,
      errorSummary: result.status === "fail" ? result.summary : null,
      metadata: {
        check: result.check,
        status: result.status,
        details: result.details,
      },
    });
    revalidatePath("/settings/mcp");
    revalidatePath("/activity");
    return actionOk({
      runId: run.id,
      checkOk: ok,
      notes: [result.summary, ...result.details],
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Check failed.",
    );
  }
}

export async function runVerificationPipelineAction(
  _prev: PipelineActionResult,
  _formData: FormData,
): Promise<PipelineActionResult> {
  try {
    const report = await runFullVerificationPipeline();
    revalidatePath("/settings/mcp");
    revalidatePath("/activity");
    return actionOk({
      runId: report.runId,
      verificationRunId: report.verificationRunId,
      verdict: report.prVerdict,
      results: report.results,
      durationMs: report.durationMs,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Verification pipeline failed.",
    );
  }
}
