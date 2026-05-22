/**
 * Health verdict for a runtime connector. Computed by `runtime-checks`
 * and shown alongside the connector chip on /settings/mcp.
 */

import type { RuntimeConnectorStatus } from "./connector-status";

export type ConnectorHealthVerdict = "healthy" | "degraded" | "broken" | "unknown";

export interface ConnectorHealthRecord {
  verdict: ConnectorHealthVerdict;
  status: RuntimeConnectorStatus;
  /** ISO timestamp. */
  observedAt: string;
  /** Why the verdict came out the way it did. Short, human-readable. */
  reason: string;
}

export const HEALTH_VERDICT_LABELS: Record<ConnectorHealthVerdict, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  broken: "Broken",
  unknown: "Unknown",
};

export function deriveHealthFromStatus(
  status: RuntimeConnectorStatus,
): ConnectorHealthVerdict {
  switch (status) {
    case "connected":
      return "healthy";
    case "configured":
    case "capability_mismatch":
    case "version_mismatch":
      return "degraded";
    case "auth_failed":
    case "unavailable":
      return "broken";
    default:
      return "unknown";
  }
}
