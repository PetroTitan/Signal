import "server-only";
import { recordActivity } from "@/repositories/activity-repository";
import type {
  AuditSource,
  McpOperationType,
} from "@/core/mcp-operations";

/**
 * Best-effort wrapper for writing an MCP-operation activity event.
 * Returns true if the row was persisted, false otherwise. The MCP
 * operation itself never fails because the audit row didn't go in —
 * it logs server-side and moves on.
 */
export async function logMcpOperation(input: {
  workspaceId: string;
  operationType: McpOperationType;
  source: AuditSource;
  title: string;
  description?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await recordActivity({
      workspaceId: input.workspaceId,
      eventType: `mcp.${input.operationType}`,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      title: input.title,
      description: input.description ?? null,
      metadata: {
        source: input.source,
        operation: input.operationType,
        ...(input.metadata ?? {}),
      },
    });
    return true;
  } catch (err) {
    console.error("[mcp-operation-audit] failed to log", err);
    return false;
  }
}
