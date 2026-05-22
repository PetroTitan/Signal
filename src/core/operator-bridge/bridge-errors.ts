/**
 * Phase E2.8 — typed errors for the operator bridge.
 */

export type BridgeErrorCode =
  | "no_workspace"
  | "not_authenticated"
  | "request_not_found"
  | "request_blocked"
  | "request_expired"
  | "request_terminal"
  | "invalid_envelope"
  | "nonce_invalid"
  | "nonce_consumed"
  | "policy_violation"
  | "schema_mismatch"
  | "unknown";

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const BRIDGE_ERROR_LABELS: Record<BridgeErrorCode, string> = {
  no_workspace: "No workspace available.",
  not_authenticated: "Not authenticated.",
  request_not_found: "Operator bridge request not found.",
  request_blocked: "Cannot create a request at this risk level.",
  request_expired: "Request expired before submission.",
  request_terminal: "Request is in a terminal state.",
  invalid_envelope: "Submitted JSON did not match the result envelope.",
  nonce_invalid: "Nonce did not match an active row for this request.",
  nonce_consumed: "Nonce was already consumed.",
  policy_violation: "Result violated the bridge policy.",
  schema_mismatch: "Result schema mismatch.",
  unknown: "Unknown bridge error.",
};

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}
