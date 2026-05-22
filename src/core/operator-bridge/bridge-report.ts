/**
 * Phase E2.8 — render-friendly aggregator. The UI summarizes the
 * latest result + verification state for a request.
 */

import type {
  BridgeResultStatus,
  BridgeVerificationStatus,
  OperatorBridgeRequest,
  OperatorBridgeResult,
} from "./bridge-types";

export interface BridgeReport {
  request: OperatorBridgeRequest;
  latestResult: OperatorBridgeResult | null;
  resultStatus: BridgeResultStatus | "no_result";
  verificationStatus: BridgeVerificationStatus | "no_result";
  isExpired: boolean;
  isTerminal: boolean;
}

export function buildBridgeReport(
  request: OperatorBridgeRequest,
  results: ReadonlyArray<OperatorBridgeResult>,
): BridgeReport {
  const latest = results[0] ?? null;
  const isExpired = new Date(request.expiresAt).getTime() < Date.now();
  return {
    request,
    latestResult: latest,
    resultStatus: latest?.status ?? "no_result",
    verificationStatus: latest?.verificationStatus ?? "no_result",
    isExpired,
    isTerminal:
      request.status === "expired" ||
      request.status === "cancelled" ||
      request.status === "rejected" ||
      request.status === "completed",
  };
}
