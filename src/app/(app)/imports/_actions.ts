"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  closeOperationRun,
  openOperationRun,
} from "@/repositories/admin-operations/mcp-operation-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import type { McpOperationType } from "@/core/mcp-operations";

export type PrepareImportResult = ActionResult<{
  runId: string;
  status: "pending_approval";
  message: string;
}>;

/**
 * Records a request to prepare an import. The actual extraction runs
 * outside Signal (in the operator's MCP-connected assistant). This
 * action persists an `mcp_operation_runs` row with status
 * `pending_approval` so the audit trail is complete and the operator
 * can see what was asked for, even when extraction is not wired.
 */
export async function prepareImportAction(
  _prev: PrepareImportResult,
  formData: FormData,
): Promise<PrepareImportResult> {
  const kind = String(formData.get("kind") ?? "").trim();
  const sourceText = String(formData.get("source_text") ?? "").trim();

  if (kind !== "product" && kind !== "account") {
    return actionFail("Unknown import kind.");
  }
  if (!sourceText) {
    return actionFail("Paste a product description or account profile first.");
  }

  const operationType: McpOperationType =
    kind === "product" ? "product_profile_suggest" : "account_profile_suggest";

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    const run = await openOperationRun({
      workspaceId,
      operationType,
      initialStatus: "pending_approval",
      inputSummary: `${kind} import requested (${sourceText.length} chars).`,
      metadata: {
        kind,
        source_length: sourceText.length,
        extraction_runtime: "not_connected",
      },
    });

    // Phase E2.6 does not run AI extraction inline. Record the request
    // and close the run with a status the operator can see.
    await closeOperationRun({
      workspaceId,
      runId: run.id,
      status: "pending_approval",
      outputSummary:
        "Extraction request prepared. AI extraction runs outside Signal; the operator must run the assistant separately and confirm fields before any record is saved.",
    });

    try {
      await recordActivity({
        workspaceId,
        eventType: "import.requested",
        entityType: "mcp_operation_run",
        entityId: run.id,
        title: `Import requested: ${kind}`,
        description: `Source length ${sourceText.length}. Extraction runtime not connected.`,
        metadata: { kind },
      });
    } catch (err) {
      console.error("[imports] activity log failed", err);
    }

    revalidatePath("/imports");
    revalidatePath("/settings/mcp");
    revalidatePath("/activity");

    return actionOk({
      runId: run.id,
      status: "pending_approval",
      message:
        "Extraction request can be prepared, but AI extraction is not connected inside Signal yet.",
    });
  } catch (err) {
    return actionFail(
      err instanceof RepositoryError
        ? err.message
        : "Could not record import request.",
    );
  }
}
