/**
 * Phase F0 — uniform MCP tool response envelope.
 */

import type { McpToolCallStatus } from "@/lib/supabase/types";

export interface McpToolResponse {
  ok: boolean;
  tool: string;
  status: "completed" | "blocked" | "failed" | "unauthorized";
  summary: string;
  data: Record<string, unknown>;
  warnings: string[];
  requires_user_approval: boolean;
  audit_id: string | null;
}

export function ok(input: {
  tool: string;
  summary: string;
  data?: Record<string, unknown>;
  warnings?: string[];
  requiresUserApproval?: boolean;
  auditId?: string | null;
}): McpToolResponse {
  return {
    ok: true,
    tool: input.tool,
    status: "completed",
    summary: input.summary,
    data: input.data ?? {},
    warnings: input.warnings ?? [],
    requires_user_approval: input.requiresUserApproval ?? false,
    audit_id: input.auditId ?? null,
  };
}

export function blocked(input: {
  tool: string;
  summary: string;
  auditId?: string | null;
  warnings?: string[];
}): McpToolResponse {
  return {
    ok: false,
    tool: input.tool,
    status: "blocked",
    summary: input.summary,
    data: {},
    warnings: input.warnings ?? [],
    requires_user_approval: false,
    audit_id: input.auditId ?? null,
  };
}

export function unauthorized(input: {
  tool: string;
  summary: string;
  auditId?: string | null;
}): McpToolResponse {
  return {
    ok: false,
    tool: input.tool,
    status: "unauthorized",
    summary: input.summary,
    data: {},
    warnings: [],
    requires_user_approval: false,
    audit_id: input.auditId ?? null,
  };
}

export function failed(input: {
  tool: string;
  summary: string;
  auditId?: string | null;
  warnings?: string[];
}): McpToolResponse {
  return {
    ok: false,
    tool: input.tool,
    status: "failed",
    summary: input.summary,
    data: {},
    warnings: input.warnings ?? [],
    requires_user_approval: false,
    audit_id: input.auditId ?? null,
  };
}

export function callStatusForResponse(
  r: McpToolResponse,
): McpToolCallStatus {
  return r.status;
}
