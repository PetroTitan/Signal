/**
 * Phase E2.6 — typed errors for the MCP runtime.
 *
 * Runtime errors are *not* surfaced as raw exceptions; they are
 * converted to RuntimeCheckResult { status: 'fail' | 'warning' } by
 * the caller.
 */

export type RuntimeErrorCode =
  | "no_workspace"
  | "not_authenticated"
  | "policy_violation"
  | "connector_unreachable"
  | "evidence_missing"
  | "unsupported_check"
  | "unknown";

export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export const RUNTIME_ERROR_LABELS: Record<RuntimeErrorCode, string> = {
  no_workspace: "No workspace available.",
  not_authenticated: "User is not authenticated.",
  policy_violation: "Operation violates runtime policy.",
  connector_unreachable: "Connector is unreachable.",
  evidence_missing: "Check could not gather evidence.",
  unsupported_check: "Check is not supported in this runtime.",
  unknown: "Unknown runtime error.",
};
