/**
 * Phase E2.8 — verification verdicts for a submitted result.
 *
 * Pure: takes the parsed envelope + nonce + request and decides
 * whether the result is verified, rejected, or failed. The caller
 * persists the verdict.
 */

import type {
  BridgeResultEnvelope,
  OperatorBridgeNonce,
  OperatorBridgeRequest,
} from "./bridge-types";

export interface VerificationVerdict {
  status: "verified" | "rejected" | "failed";
  errors: string[];
}

export function verifyEnvelopeAgainstRequest(input: {
  envelope: BridgeResultEnvelope;
  request: OperatorBridgeRequest;
  nonce: OperatorBridgeNonce | null;
}): VerificationVerdict {
  const errors: string[] = [];

  if (input.envelope.request_id !== input.request.id) {
    errors.push("request_id_mismatch");
  }
  if (input.envelope.assistant_type !== input.request.assistantType) {
    errors.push("assistant_type_mismatch");
  }
  if (!input.nonce) {
    errors.push("nonce_not_found");
  } else {
    if (input.nonce.workspaceId !== input.request.workspaceId) {
      errors.push("nonce_workspace_mismatch");
    }
    if (input.nonce.requestId !== input.request.id) {
      errors.push("nonce_request_mismatch");
    }
    if (input.nonce.status !== "active") {
      errors.push(`nonce_${input.nonce.status}`);
    } else if (new Date(input.nonce.expiresAt).getTime() < Date.now()) {
      errors.push("nonce_expired");
    }
  }
  if (
    input.request.status === "verified" ||
    input.request.status === "completed" ||
    input.request.status === "cancelled" ||
    input.request.status === "rejected" ||
    input.request.status === "expired"
  ) {
    errors.push(`request_${input.request.status}`);
  }
  if (new Date(input.request.expiresAt).getTime() < Date.now()) {
    errors.push("request_expired");
  }

  if (errors.length > 0) {
    // If the *only* problems are envelope-schema-shaped, surface as
    // failed; otherwise the envelope itself was rejected.
    const onlySchemaIssues = errors.every((e) =>
      ["invalid_summary", "invalid_status", "checks_not_array"].includes(e),
    );
    return {
      status: onlySchemaIssues ? "failed" : "rejected",
      errors,
    };
  }
  return { status: "verified", errors: [] };
}
