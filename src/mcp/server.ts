import "server-only";
import { closeToolCall, openToolCall } from "./audit";
import { extractBearer, hashToken } from "./auth";
import { McpError } from "./errors";
import { hasAllScopes } from "./permissions";
import {
  BLOCKED_TOOL_NAMES,
  TOOLS_BY_NAME,
  buildBlockedResponse,
} from "./tool-registry";
import {
  blocked,
  failed,
  unauthorized,
  type McpToolResponse,
} from "./responses";
import {
  lookupTokenByHash,
  touchTokenLastUsed,
} from "@/repositories/mcp-server/operator-token-repository";
import {
  createSupabaseServiceRoleClient,
  isServiceRoleAvailable,
} from "@/lib/supabase/service-role";

/**
 * Phase F0 — MCP HTTP bridge dispatcher.
 *
 * Request envelope:
 *   { tool: string, args?: object }
 *
 * The route handler does the HTTP plumbing; this module does the
 * auth + dispatch + audit.
 */
export interface DispatchRequest {
  authorization: string | null;
  tool: string;
  args: unknown;
}

export interface DispatchResponseEnvelope {
  status: number;
  body: McpToolResponse | { ok: false; status: "unauthorized" | "blocked"; tool: string; summary: string; data: Record<string, unknown>; warnings: string[]; requires_user_approval: false; audit_id: null; error_code?: string };
}

export async function dispatch(
  input: DispatchRequest,
): Promise<DispatchResponseEnvelope> {
  // 0) Hard precondition: the bridge cannot authenticate any token
  //    when the service-role key is missing. Surface that honestly
  //    instead of collapsing into "invalid_token".
  if (!isServiceRoleAvailable()) {
    return {
      status: 503,
      body: failed({
        tool: input.tool ?? "(unknown)",
        summary:
          "Signal MCP server is not configured. SUPABASE_SERVICE_ROLE_KEY is unset on the server.",
      }),
    };
  }

  // 1) Auth
  let plaintext: string;
  try {
    plaintext = extractBearer(input.authorization);
  } catch (err) {
    if (err instanceof McpError) {
      return {
        status: err.httpStatus,
        body: {
          ok: false,
          status: "unauthorized",
          tool: input.tool ?? "(unknown)",
          summary: err.message,
          data: {},
          warnings: [],
          requires_user_approval: false,
          audit_id: null,
          error_code: err.code,
        },
      };
    }
    throw err;
  }

  const tokenHash = await hashToken(plaintext);
  const token = await lookupTokenByHash(tokenHash);
  if (!token) {
    return {
      status: 401,
      body: {
        ok: false,
        status: "unauthorized",
        tool: input.tool ?? "(unknown)",
        summary: "Bearer token is not recognized.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
        error_code: "invalid_token",
      },
    };
  }
  if (token.status === "revoked") {
    return {
      status: 401,
      body: {
        ok: false,
        status: "unauthorized",
        tool: input.tool ?? "(unknown)",
        summary: "Token has been revoked.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
        error_code: "token_revoked",
      },
    };
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
    return {
      status: 401,
      body: {
        ok: false,
        status: "unauthorized",
        tool: input.tool ?? "(unknown)",
        summary: "Token has expired.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
        error_code: "token_expired",
      },
    };
  }

  // 2) Blocked tool short-circuit (no need to consult registry).
  if (BLOCKED_TOOL_NAMES.has(input.tool)) {
    const auditId = await openToolCall({
      workspaceId: token.workspaceId,
      operatorTokenId: token.id,
      toolName: input.tool,
      riskLevel: "blocked",
      approvalMode: "blocked",
    });
    if (auditId) {
      await closeToolCall({
        workspaceId: token.workspaceId,
        callId: auditId,
        status: "blocked",
        errorSummary: "tool_blocked",
      });
    }
    const response = buildBlockedResponse(input.tool);
    response.audit_id = auditId;
    return { status: 403, body: response };
  }

  const definition = TOOLS_BY_NAME[input.tool];
  if (!definition) {
    return {
      status: 404,
      body: {
        ok: false,
        status: "failed",
        tool: input.tool ?? "(unknown)",
        summary: "Unknown tool name.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
      } as McpToolResponse,
    };
  }

  // 3) Scope check
  if (!hasAllScopes(token.scopes, definition.requiredScopes)) {
    const auditId = await openToolCall({
      workspaceId: token.workspaceId,
      operatorTokenId: token.id,
      toolName: input.tool,
      riskLevel: definition.riskLevel,
      approvalMode: definition.approvalMode,
    });
    if (auditId) {
      await closeToolCall({
        workspaceId: token.workspaceId,
        callId: auditId,
        status: "unauthorized",
        errorSummary: `missing_scopes:${definition.requiredScopes
          .filter((s) => !token.scopes.includes(s))
          .join(",")}`,
      });
    }
    const response = unauthorized({
      tool: input.tool,
      summary: `Token does not include the required scopes: ${definition.requiredScopes.join(", ")}.`,
      auditId,
    });
    return { status: 403, body: response };
  }

  // 4) Parse args
  const parsed = definition.parseArgs(input.args ?? {});
  if (!parsed.ok) {
    const auditId = await openToolCall({
      workspaceId: token.workspaceId,
      operatorTokenId: token.id,
      toolName: input.tool,
      riskLevel: definition.riskLevel,
      approvalMode: definition.approvalMode,
    });
    if (auditId) {
      await closeToolCall({
        workspaceId: token.workspaceId,
        callId: auditId,
        status: "failed",
        errorSummary: `invalid_arguments:${parsed.errors.join(",")}`,
      });
    }
    return {
      status: 400,
      body: failed({
        tool: input.tool,
        summary: `Invalid arguments: ${parsed.errors.join(", ")}`,
        auditId,
      }),
    };
  }

  // 5) Build context and dispatch
  const db = createSupabaseServiceRoleClient();
  if (!db) {
    return {
      status: 503,
      body: failed({
        tool: input.tool,
        summary:
          "Signal MCP server is not configured for external calls (SUPABASE_SERVICE_ROLE_KEY is unset).",
      }),
    };
  }

  const auditId = await openToolCall({
    workspaceId: token.workspaceId,
    operatorTokenId: token.id,
    toolName: input.tool,
    riskLevel: definition.riskLevel,
    approvalMode: definition.approvalMode,
    inputSummary: definition.writesDatabase
      ? safeArgsSummary(input.tool, parsed.value)
      : "(read-only)",
  });

  await touchTokenLastUsed({
    workspaceId: token.workspaceId,
    tokenId: token.id,
  });

  try {
    const response = await definition.handler(
      {
        workspaceId: token.workspaceId,
        operatorTokenId: token.id,
        scopes: token.scopes,
        token,
        db,
      },
      parsed.value,
    );
    response.audit_id = auditId;
    if (auditId) {
      await closeToolCall({
        workspaceId: token.workspaceId,
        callId: auditId,
        status: response.status,
        outputSummary: response.summary.slice(0, 4000),
        errorSummary:
          response.status === "failed" || response.status === "blocked"
            ? response.summary.slice(0, 1000)
            : null,
      });
    }
    return { status: response.ok ? 200 : 400, body: response };
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    if (auditId) {
      await closeToolCall({
        workspaceId: token.workspaceId,
        callId: auditId,
        status: "failed",
        errorSummary: message.slice(0, 1000),
      });
    }
    return {
      status: 500,
      body: failed({
        tool: input.tool,
        summary: "Tool execution failed.",
        auditId,
      }),
    };
  }
}

/**
 * Tiny summary of the tool input — never includes raw bodies of fields
 * that could contain secrets. Most prepare tools already validate
 * inputs are small; this surface only records key names + counts.
 */
function safeArgsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return `${toolName}: no args`;
  const keys = Object.keys(args as Record<string, unknown>);
  return `${toolName}: ${keys.length} field(s) — ${keys.join(", ")}`;
}

export { TOOLS, BLOCKED_TOOL_NAMES, TOOLS_BY_NAME } from "./tool-registry";
