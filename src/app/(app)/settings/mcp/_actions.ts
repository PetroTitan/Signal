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
import { runWorkspaceSmokeTest } from "@/repositories/admin-operations/smoke-test-operations";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import type { McpOperationType } from "@/core/mcp-operations";

export type ApproveResult = ActionResult<{ runId: string }>;
export type RejectResult = ActionResult<{ runId: string }>;
export type RunCheckResult = ActionResult<{
  runId: string;
  checkOk: boolean;
  notes: string[];
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
  const operationType = String(formData.get("operation_type") ?? "").trim() as
    | McpOperationType
    | "";
  if (!operationType) return actionFail("Missing operation type.");

  if (operationType !== "smoke_test_run") {
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
      operationType,
      initialStatus: "running",
      inputSummary: `Manual run: ${operationType}`,
    });

    const result = await runWorkspaceSmokeTest();

    if (result.ok) {
      await closeOperationRun({
        workspaceId,
        runId: run.id,
        status: "completed",
        outputSummary: result.notes.join(" ") || null,
        metadata: { checks: result.payload.checks, allOk: result.payload.allOk },
      });
      revalidatePath("/settings/mcp");
      revalidatePath("/activity");
      return actionOk({ runId: run.id, checkOk: true, notes: result.notes });
    }

    await closeOperationRun({
      workspaceId,
      runId: run.id,
      status: "failed",
      errorSummary: result.error,
    });
    revalidatePath("/settings/mcp");
    return actionOk({ runId: run.id, checkOk: false, notes: result.notes });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError ? err.message : "Check failed.",
    );
  }
}
