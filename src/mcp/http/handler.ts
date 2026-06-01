/**
 * Phase F8 — MCP method handler (Streamable HTTP / JSON-RPC).
 *
 * Implements just enough of the Model Context Protocol for Claude Code
 * / mcp-remote:
 *
 *   - initialize                (protocol + capability negotiation)
 *   - notifications/initialized (handshake ack — fire-and-forget)
 *   - ping                      (keepalive)
 *   - tools/list                (advertise the Signal tool surface)
 *   - tools/call                (invoke a Signal tool)
 *
 * Auth model
 * ----------
 *   - initialize / notifications/* / ping : open (negotiation only).
 *   - tools/list                          : requires a valid token
 *                                           (don't leak the catalog).
 *   - tools/call                          : authenticated by the
 *                                           existing dispatcher
 *                                           (HTTP 401 → JSON-RPC auth
 *                                           error).
 *
 * Tool calls are forwarded UNCHANGED to the existing `/api/mcp`
 * dispatcher, so scopes, the deny-list, audit logging, and operator
 * approval all behave identically. The dispatcher's response envelope
 * (including `requires_user_approval` and `audit_id`) is surfaced as
 * MCP tool-result `content` + `structuredContent`.
 *
 * Dependencies are injected so this module is pure and unit-testable
 * without a database or `server-only` modules.
 */

import {
  JSON_RPC_ERRORS,
  isNotification,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./jsonrpc";
import type { McpAuthResult } from "./authenticate";

/** Protocol version we advertise when the client doesn't pin one. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const MCP_SERVER_INFO = {
  name: "signal",
  version: "1.0.0",
} as const;

/** One tool as advertised in `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Minimal shape of the existing dispatcher's response envelope. */
export interface DispatchEnvelope {
  status: number;
  body: {
    ok: boolean;
    tool: string;
    status: string;
    summary: string;
    data?: Record<string, unknown>;
    warnings?: string[];
    requires_user_approval?: boolean;
    audit_id?: string | null;
    error_code?: string;
  };
}

export interface McpHandlerDeps {
  /** Token check for tools/list. Mirrors the dispatcher's auth. */
  authenticate: (authorization: string | null) => Promise<McpAuthResult>;
  /** The existing `/api/mcp` dispatcher — UNCHANGED. */
  dispatch: (input: {
    authorization: string | null;
    tool: string;
    args: unknown;
  }) => Promise<DispatchEnvelope>;
  /** Tool catalog with JSON-Schema, built from the live registry. */
  listTools: () => McpToolDescriptor[];
}

export interface McpHandledResponse {
  /** HTTP status the route should send. */
  status: number;
  /** JSON-RPC body, or null for an accepted notification (HTTP 202). */
  body: JsonRpcResponse | null;
}

/**
 * Route a single parsed JSON value (already `JSON.parse`d by the HTTP
 * layer) through the MCP protocol. Never throws; always returns a
 * well-formed JSON-RPC response (or null for notifications).
 */
export async function handleMcpMessage(input: {
  authorization: string | null;
  message: unknown;
  deps: McpHandlerDeps;
}): Promise<McpHandledResponse> {
  const parsed = parseJsonRpcMessage(input.message);
  if (!parsed.ok) {
    // Malformed JSON-RPC envelope → invalid request (HTTP 400).
    return {
      status: 400,
      body: jsonRpcError(parsed.id, parsed.code, parsed.message),
    };
  }

  const req = parsed.value;

  // Notifications (no id) are fire-and-forget. We accept the handshake
  // ack (and any other notification) with HTTP 202 and no body.
  if (isNotification(req)) {
    return { status: 202, body: null };
  }

  const id: JsonRpcId = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return handleInitialize(id, req.params);
    case "ping":
      // MCP keepalive — empty result.
      return { status: 200, body: jsonRpcResult(id, {}) };
    case "tools/list":
      return handleToolsList(id, input.authorization, input.deps);
    case "tools/call":
      return handleToolsCall(id, req.params, input.authorization, input.deps);
    default:
      return {
        status: 200,
        body: jsonRpcError(
          id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Method not found: ${req.method}`,
        ),
      };
  }
}

function handleInitialize(
  id: JsonRpcId,
  params: unknown,
): McpHandledResponse {
  // Echo the client's requested protocol version when it sends one;
  // otherwise advertise our default. Both are valid per the spec.
  const requested =
    params && typeof params === "object"
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
  const protocolVersion =
    typeof requested === "string" && requested.length > 0
      ? requested
      : DEFAULT_PROTOCOL_VERSION;

  return {
    status: 200,
    body: jsonRpcResult(id, {
      protocolVersion,
      serverInfo: MCP_SERVER_INFO,
      capabilities: {
        // We expose tools only. `listChanged: false` — the catalog is
        // static for the life of the process.
        tools: { listChanged: false },
      },
    }),
  };
}

async function handleToolsList(
  id: JsonRpcId,
  authorization: string | null,
  deps: McpHandlerDeps,
): Promise<McpHandledResponse> {
  const auth = await deps.authenticate(authorization);
  if (!auth.ok) {
    return unauthorized(id, auth);
  }
  return {
    status: 200,
    body: jsonRpcResult(id, { tools: deps.listTools() }),
  };
}

async function handleToolsCall(
  id: JsonRpcId,
  params: unknown,
  authorization: string | null,
  deps: McpHandlerDeps,
): Promise<McpHandledResponse> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      status: 200,
      body: jsonRpcError(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'tools/call requires a params object with a "name".',
      ),
    };
  }
  const p = params as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.length === 0) {
    return {
      status: 200,
      body: jsonRpcError(
        id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'tools/call params must include a "name" string.',
      ),
    };
  }
  const args =
    p.arguments !== undefined && p.arguments !== null ? p.arguments : {};

  // Forward to the existing dispatcher UNCHANGED — it owns auth,
  // scopes, the deny-list, audit, and approval behavior.
  const dispatched = await deps.dispatch({
    authorization,
    tool: p.name,
    args,
  });

  // Transport-level auth failures (missing / invalid / revoked /
  // expired token) come back as HTTP 401. Surface them as a JSON-RPC
  // auth error so the client knows to fix credentials, not arguments.
  if (dispatched.status === 401) {
    return {
      status: 401,
      body: jsonRpcError(
        id,
        JSON_RPC_ERRORS.UNAUTHORIZED,
        dispatched.body.summary || "Unauthorized.",
        { error_code: dispatched.body.error_code ?? "unauthorized" },
      ),
    };
  }

  // Everything else — success, blocked, scope-insufficient, invalid
  // args, tool failure — is a valid tool RESULT. Per MCP, tool-level
  // failures travel inside the result with isError=true so the model
  // can read and react to them.
  return {
    status: 200,
    body: jsonRpcResult(id, toToolResult(dispatched.body)),
  };
}

/**
 * Map the Signal tool envelope into an MCP `tools/call` result. The
 * full envelope (summary, status, warnings, requires_user_approval,
 * audit_id, data) rides along as both human-readable text and
 * machine-readable structuredContent.
 */
function toToolResult(
  body: DispatchEnvelope["body"],
): Record<string, unknown> {
  const lines = [body.summary];
  if (body.requires_user_approval) {
    lines.push(
      "Requires operator approval in Signal before it takes effect.",
    );
  }
  if (body.warnings && body.warnings.length > 0) {
    lines.push(`Warnings: ${body.warnings.join("; ")}`);
  }
  lines.push("", JSON.stringify(body, null, 2));

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: !body.ok,
    structuredContent: body,
  };
}

function unauthorized(
  id: JsonRpcId,
  auth: Extract<McpAuthResult, { ok: false }>,
): McpHandledResponse {
  return {
    status: auth.httpStatus,
    body: jsonRpcError(id, JSON_RPC_ERRORS.UNAUTHORIZED, auth.message, {
      error_code: auth.errorCode,
    }),
  };
}
