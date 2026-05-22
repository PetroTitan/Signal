/**
 * Phase E2.6 — extended runtime connector status.
 *
 * The Phase E0 status set ("placeholder | manual | configured | ...") is
 * preserved for backwards compatibility in `src/core/mcp-operations/
 * connector-status.ts`. This module adds the runtime-flavored states a
 * real probe can return (`auth_failed`, `capability_mismatch`,
 * `version_mismatch`).
 *
 * Rule: never claim `connected` unless verified within the recent
 * observation window. When we can't observe the state, the value is
 * `placeholder` and the UI says so.
 */

export const RUNTIME_CONNECTOR_STATUSES = [
  "not_configured",
  "configured",
  "connected",
  "unavailable",
  "auth_failed",
  "capability_mismatch",
  "version_mismatch",
  "placeholder",
  "manual",
] as const;
export type RuntimeConnectorStatus = (typeof RUNTIME_CONNECTOR_STATUSES)[number];

export const RUNTIME_CONNECTOR_STATUS_LABELS: Record<RuntimeConnectorStatus, string> = {
  not_configured: "Not configured",
  configured: "Configured",
  connected: "Connected",
  unavailable: "Unavailable",
  auth_failed: "Auth failed",
  capability_mismatch: "Capability mismatch",
  version_mismatch: "Version mismatch",
  placeholder: "Placeholder",
  manual: "Manual",
};

export const RUNTIME_CONNECTOR_STATUS_HINTS: Record<RuntimeConnectorStatus, string> = {
  not_configured: "No setup detected for this connector yet.",
  configured: "Configuration present, awaiting verification.",
  connected: "Verified within the recent observation window.",
  unavailable: "The connector reported an outage.",
  auth_failed: "Connector responded but rejected the credentials.",
  capability_mismatch: "Connector is reachable but a required capability is missing.",
  version_mismatch: "Connector is reachable but on an incompatible version.",
  placeholder: "Operator-connected outside Signal. Not directly probeable yet.",
  manual: "Operated by humans through this UI — no remote tool needed.",
};
