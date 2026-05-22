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

export async function approveMcpOperationAction(
  _prev: ApproveResult,
  formData: FormData,
): Promise<ApproveResult> {
  const runId = String(formData.get("run_id") ?? "").trim();
  if (!runId) return actionFail("Missing run id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return actionFail("Not authenticated.");

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
