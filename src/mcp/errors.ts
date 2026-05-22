/**
 * Phase F0 — typed errors for the MCP HTTP bridge.
 *
 * The dispatcher converts these into structured response bodies; the
 * client never sees a raw exception.
 */

export type McpErrorCode =
  | "missing_authorization"
  | "invalid_token"
  | "token_revoked"
  | "token_expired"
  | "scope_insufficient"
  | "tool_unknown"
  | "tool_blocked"
  | "invalid_arguments"
  | "workspace_missing"
  | "policy_violation"
  | "internal_error";

export class McpError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export const MCP_ERROR_LABELS: Record<McpErrorCode, string> = {
  missing_authorization: "Bearer token is missing.",
  invalid_token: "Bearer token is not recognized.",
  token_revoked: "This token has been revoked.",
  token_expired: "This token has expired.",
  scope_insufficient: "Token does not include the required scopes.",
  tool_unknown: "Unknown tool name.",
  tool_blocked: "This tool name is explicitly blocked by the Signal MCP policy.",
  invalid_arguments: "Tool arguments did not pass validation.",
  workspace_missing: "Could not resolve a workspace for the token.",
  policy_violation: "Tool call violates the MCP policy.",
  internal_error: "Tool execution failed.",
};
