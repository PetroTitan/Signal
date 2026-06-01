/**
 * Phase F8 — JSON-RPC 2.0 primitives for the real MCP endpoint.
 *
 * This module is intentionally transport- and Signal-agnostic: it only
 * knows the JSON-RPC 2.0 envelope and how to validate / build it. The
 * MCP-specific routing (initialize / tools/list / tools/call) lives in
 * `./handler.ts`, and the HTTP plumbing lives in
 * `src/app/api/mcp/http/route.ts`.
 *
 * No `server-only` import here on purpose — these helpers are pure and
 * unit-tested directly.
 */

export const JSONRPC_VERSION = "2.0";

/** JSON-RPC ids may be a string, a number, or null. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent on notifications. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * Standard JSON-RPC 2.0 error codes plus the reserved server-error
 * range we use for transport-level auth failures. Auth is modelled as
 * a server error (not -32600 invalid request) so MCP clients surface
 * "unauthorized" distinctly from a malformed envelope.
 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Implementation-defined server error: bearer token missing / invalid. */
  UNAUTHORIZED: -32001,
} as const;

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/**
 * A method name with no `id` is a JSON-RPC *notification* — the server
 * performs the side effect (if any) and returns no response body.
 */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

export type ParsedMessage =
  | { ok: true; value: JsonRpcRequest }
  | { ok: false; id: JsonRpcId; code: number; message: string };

/**
 * Validate that a parsed JSON value is a single well-formed JSON-RPC
 * 2.0 request/notification object.
 *
 * Returns a structured failure (never throws) so the caller can decide
 * the HTTP status and emit a proper JSON-RPC error envelope. We extract
 * a best-effort `id` from malformed-but-object payloads so the error
 * response can echo it back per the spec.
 *
 * The 2025 MCP Streamable HTTP profile drops JSON-RPC batching, so a
 * top-level array is rejected as an invalid request.
 */
export function parseJsonRpcMessage(raw: unknown): ParsedMessage {
  if (Array.isArray(raw)) {
    return {
      ok: false,
      id: null,
      code: JSON_RPC_ERRORS.INVALID_REQUEST,
      message: "JSON-RPC batch requests are not supported.",
    };
  }
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      id: null,
      code: JSON_RPC_ERRORS.INVALID_REQUEST,
      message: "Request must be a JSON-RPC 2.0 object.",
    };
  }
  const obj = raw as Record<string, unknown>;
  const id = extractId(obj);

  if (obj.jsonrpc !== JSONRPC_VERSION) {
    return {
      ok: false,
      id,
      code: JSON_RPC_ERRORS.INVALID_REQUEST,
      message: 'Missing or invalid "jsonrpc": must be "2.0".',
    };
  }
  if (typeof obj.method !== "string" || obj.method.length === 0) {
    return {
      ok: false,
      id,
      code: JSON_RPC_ERRORS.INVALID_REQUEST,
      message: 'Missing or invalid "method": must be a non-empty string.',
    };
  }
  if (
    obj.params !== undefined &&
    (typeof obj.params !== "object" || obj.params === null)
  ) {
    return {
      ok: false,
      id,
      code: JSON_RPC_ERRORS.INVALID_REQUEST,
      message: '"params" must be an object or array when present.',
    };
  }

  const value: JsonRpcRequest = {
    jsonrpc: JSONRPC_VERSION,
    method: obj.method,
    params: obj.params,
  };
  if ("id" in obj) value.id = id;
  return { ok: true, value };
}

function extractId(obj: Record<string, unknown>): JsonRpcId {
  const v = obj.id;
  if (typeof v === "string" || typeof v === "number" || v === null) return v;
  return null;
}
