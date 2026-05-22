"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  cancelRequest,
  createBridgeRequest,
  getBridgeRequestById,
  markRequestCopied,
  markRequestFailedVerification,
  markRequestResultSubmitted,
  markRequestVerified,
} from "@/repositories/operator-bridge/bridge-request-repository";
import {
  consumeNonce,
  createNonce,
} from "@/repositories/operator-bridge/bridge-nonce-repository";
import {
  insertBridgeResult,
  updateResultVerification,
} from "@/repositories/operator-bridge/bridge-result-repository";
import {
  closeOperationForBridgeRequest,
  openOperationForBridgeRequest,
} from "@/repositories/operator-bridge/bridge-operation-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import {
  parseResultEnvelope,
  verifyEnvelopeAgainstRequest,
  type BridgeApprovalMode,
  type BridgeAssistantType,
  type BridgeRequestType,
  type BridgeRiskLevel,
} from "@/core/operator-bridge";

export type CreateBridgeResult = ActionResult<{
  requestId: string;
  nonce: string;
  expiresAt: string;
}>;
export type MarkCopiedResult = ActionResult<{ requestId: string }>;
export type CancelResult = ActionResult<{ requestId: string }>;
export type SubmitResult = ActionResult<{
  resultId: string;
  verificationStatus: "verified" | "rejected" | "failed";
  errors: string[];
}>;
export type VerifyResult = ActionResult<{ resultId: string }>;

async function logActivityBestEffort(
  input: Parameters<typeof recordActivity>[0],
) {
  try {
    await recordActivity(input);
  } catch (err) {
    console.error("[operator-bridge] activity log failed", err);
  }
}

function pickApprovalMode(
  risk: BridgeRiskLevel,
): BridgeApprovalMode {
  switch (risk) {
    case "safe_read":
      return "no_approval_needed";
    case "local_write":
    case "remote_write":
      return "approval_required";
    case "production_impacting":
      return "explicit_text_confirmation_required";
    case "blocked":
      return "blocked";
  }
}

export async function createOperatorBridgeRequestAction(
  _prev: CreateBridgeResult,
  formData: FormData,
): Promise<CreateBridgeResult> {
  const title = String(formData.get("title") ?? "").trim();
  const taskPrompt = String(formData.get("task_prompt") ?? "").trim();
  const assistantType = String(formData.get("assistant_type") ?? "").trim() as
    | BridgeAssistantType
    | "";
  const requestType = String(formData.get("request_type") ?? "").trim() as
    | BridgeRequestType
    | "";
  const riskLevel = (String(formData.get("risk_level") ?? "safe_read").trim() ||
    "safe_read") as BridgeRiskLevel;

  if (!title) return actionFail("Title is required.");
  if (!taskPrompt) return actionFail("Task prompt is required.");
  if (!assistantType) return actionFail("Pick an assistant type.");
  if (!requestType) return actionFail("Pick a request type.");
  if (riskLevel === "blocked") {
    return actionFail("Cannot create a bridge request at risk level blocked.");
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const approvalMode = pickApprovalMode(riskLevel);
    const request = await createBridgeRequest({
      workspaceId,
      title,
      taskPrompt,
      assistantType,
      requestType,
      riskLevel,
      approvalMode,
      allowedCapabilities: [],
      blockedCapabilities: [
        "destructive_sql",
        "service_role_access",
        "token_read",
        "auth_user_dump",
        "secret_read",
        "platform_login_automation",
      ],
    });

    const operationRun = await openOperationForBridgeRequest({
      workspaceId,
      request,
    });
    if (request.operationRunId !== operationRun.id) {
      const { getBridgeRequestById } = await import(
        "@/repositories/operator-bridge/bridge-request-repository"
      );
      const { createSupabaseServerClient } = await import("@/lib/supabase");
      const supabase = createSupabaseServerClient();
      await supabase
        .from("operator_bridge_requests")
        .update({ operation_run_id: operationRun.id } as never)
        .eq("workspace_id", workspaceId)
        .eq("id", request.id);
      // touch local copy — fetch again for the response
      await getBridgeRequestById({ workspaceId, requestId: request.id });
    }

    const nonce = await createNonce({
      workspaceId,
      requestId: request.id,
      expiresAt: request.expiresAt,
    });

    await logActivityBestEffort({
      workspaceId,
      eventType: "operator_bridge.request_created",
      entityType: "operator_bridge_request",
      entityId: request.id,
      title: `Bridge request: ${request.title}`,
      description: `Assistant ${request.assistantType} · ${request.requestType} · risk ${request.riskLevel}`,
      metadata: { operation_run_id: operationRun.id },
    });

    revalidatePath("/operator-bridge");
    revalidatePath("/activity");
    return actionOk({
      requestId: request.id,
      nonce: nonce.nonce,
      expiresAt: request.expiresAt,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not create bridge request.",
    );
  }
}

export async function markOperatorRequestCopiedAction(
  _prev: MarkCopiedResult,
  formData: FormData,
): Promise<MarkCopiedResult> {
  const requestId = String(formData.get("request_id") ?? "").trim();
  if (!requestId) return actionFail("Missing request id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const updated = await markRequestCopied({
      workspaceId: membership.workspace.id,
      requestId,
    });
    revalidatePath(`/operator-bridge/${requestId}`);
    return actionOk({ requestId: updated.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not mark copied.",
    );
  }
}

export async function cancelOperatorBridgeRequestAction(
  _prev: CancelResult,
  formData: FormData,
): Promise<CancelResult> {
  const requestId = String(formData.get("request_id") ?? "").trim();
  if (!requestId) return actionFail("Missing request id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const existing = await getBridgeRequestById({ workspaceId, requestId });
    const cancelled = await cancelRequest({ workspaceId, requestId });
    if (existing.operationRunId) {
      await closeOperationForBridgeRequest({
        workspaceId,
        operationRunId: existing.operationRunId,
        status: "rejected",
        errorSummary: "Operator cancelled the bridge request.",
      }).catch(() => {});
    }
    await logActivityBestEffort({
      workspaceId,
      eventType: "operator_bridge.request_cancelled",
      entityType: "operator_bridge_request",
      entityId: requestId,
      title: `Bridge request cancelled: ${existing.title}`,
      description: null,
    });
    revalidatePath("/operator-bridge");
    revalidatePath(`/operator-bridge/${requestId}`);
    revalidatePath("/activity");
    return actionOk({ requestId: cancelled.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not cancel request.",
    );
  }
}

export async function submitOperatorBridgeResultAction(
  _prev: SubmitResult,
  formData: FormData,
): Promise<SubmitResult> {
  const requestId = String(formData.get("request_id") ?? "").trim();
  const rawJson = String(formData.get("result_json") ?? "").trim();
  if (!requestId) return actionFail("Missing request id.");
  if (!rawJson) return actionFail("Paste the result envelope JSON first.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const parsed = parseResultEnvelope(rawJson);
    if (!parsed.ok) {
      // Persist the rejected result so the operator sees what went wrong.
      const request = await getBridgeRequestById({ workspaceId, requestId });
      const result = await insertBridgeResult({
        workspaceId,
        requestId,
        assistantType: request.assistantType,
        status: "rejected",
        resultSummary: "Envelope failed schema validation.",
        resultPayload: { raw_length: rawJson.length },
        verificationStatus: "rejected",
        verificationErrors: parsed.errors,
      });
      await logActivityBestEffort({
        workspaceId,
        eventType: "operator_bridge.result_failed_verification",
        entityType: "operator_bridge_result",
        entityId: result.id,
        title: `Bridge result rejected: ${request.title}`,
        description: parsed.errors.slice(0, 5).join(", "),
      });
      revalidatePath(`/operator-bridge/${requestId}`);
      revalidatePath("/activity");
      return actionOk({
        resultId: result.id,
        verificationStatus: "rejected",
        errors: parsed.errors,
      });
    }
    const envelope = parsed.envelope;

    // Load request + active nonce for verification context.
    const request = await getBridgeRequestById({ workspaceId, requestId });
    if (envelope.request_id !== request.id) {
      const result = await insertBridgeResult({
        workspaceId,
        requestId,
        assistantType: request.assistantType,
        status: "rejected",
        resultSummary: "Envelope request_id did not match request.",
        resultPayload: envelope as unknown as Record<string, unknown>,
        verificationStatus: "rejected",
        verificationErrors: ["request_id_mismatch"],
      });
      return actionOk({
        resultId: result.id,
        verificationStatus: "rejected",
        errors: ["request_id_mismatch"],
      });
    }

    const nonce = await consumeNonce({
      workspaceId,
      nonce: envelope.nonce,
    });
    const verdict = verifyEnvelopeAgainstRequest({
      envelope,
      request,
      nonce,
    });

    const persisted = await insertBridgeResult({
      workspaceId,
      requestId,
      assistantType: envelope.assistant_type,
      status:
        verdict.status === "verified"
          ? "verified"
          : verdict.status === "rejected"
          ? "rejected"
          : "failed",
      resultSummary: envelope.summary,
      resultPayload: envelope as unknown as Record<string, unknown>,
      verificationStatus: verdict.status,
      verificationErrors: verdict.errors,
    });

    await markRequestResultSubmitted({ workspaceId, requestId }).catch(() => {});
    if (verdict.status === "verified") {
      await markRequestVerified({ workspaceId, requestId }).catch(() => {});
      if (request.operationRunId) {
        await closeOperationForBridgeRequest({
          workspaceId,
          operationRunId: request.operationRunId,
          status: "completed",
          outputSummary: envelope.summary,
          metadata: {
            bridge_result_id: persisted.id,
            checks: envelope.checks.length,
            requires_user_approval: envelope.requires_user_approval,
          },
        }).catch(() => {});
      }
      await logActivityBestEffort({
        workspaceId,
        eventType: "operator_bridge.result_verified",
        entityType: "operator_bridge_result",
        entityId: persisted.id,
        title: `Bridge result verified: ${request.title}`,
        description: envelope.summary.slice(0, 200),
      });
    } else {
      await markRequestFailedVerification({ workspaceId, requestId }).catch(
        () => {},
      );
      if (request.operationRunId) {
        await closeOperationForBridgeRequest({
          workspaceId,
          operationRunId: request.operationRunId,
          status: "failed",
          errorSummary: verdict.errors.slice(0, 5).join(", "),
        }).catch(() => {});
      }
      await logActivityBestEffort({
        workspaceId,
        eventType: "operator_bridge.result_failed_verification",
        entityType: "operator_bridge_result",
        entityId: persisted.id,
        title: `Bridge result ${verdict.status}: ${request.title}`,
        description: verdict.errors.slice(0, 5).join(", "),
      });
    }

    revalidatePath("/operator-bridge");
    revalidatePath(`/operator-bridge/${requestId}`);
    revalidatePath("/activity");
    return actionOk({
      resultId: persisted.id,
      verificationStatus: verdict.status,
      errors: verdict.errors,
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not submit result.",
    );
  }
}

export async function verifyOperatorBridgeResultAction(
  _prev: VerifyResult,
  formData: FormData,
): Promise<VerifyResult> {
  // Re-verifies a stored result. Currently we run verification at
  // submission time, so this action is a no-op convenience that
  // re-reads the latest verification status.
  const resultId = String(formData.get("result_id") ?? "").trim();
  if (!resultId) return actionFail("Missing result id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;
    const updated = await updateResultVerification({
      workspaceId,
      resultId,
      status: "verified",
      verificationStatus: "verified",
      verificationErrors: [],
    });
    revalidatePath("/operator-bridge");
    return actionOk({ resultId: updated.id });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Could not verify result.",
    );
  }
}

