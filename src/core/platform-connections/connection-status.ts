export const CONNECTION_STATUSES = [
  "not_connected",
  "ready_to_connect",
  "connected",
  "expired",
  "revoked",
  "error",
  "disabled",
] as const;

export type PlatformConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<PlatformConnectionStatus, string> = {
  not_connected: "Not connected",
  ready_to_connect: "Ready to connect",
  connected: "Connected",
  expired: "Connection expired",
  revoked: "Connection revoked",
  error: "Requires reauthorization",
  disabled: "Disabled",
};

export const CONNECTION_STATUS_USER_HINTS: Record<PlatformConnectionStatus, string> = {
  not_connected:
    "Create the account on the platform first, then connect through official OAuth.",
  ready_to_connect:
    "Account is set up. Connect through official OAuth when integrations ship.",
  connected: "Signal can read what you've allowed. You still approve everything.",
  expired: "Reauthorize to continue using this connection.",
  revoked: "You revoked this connection. Reconnect to use it again.",
  error: "Reauthorize to restore this connection.",
  disabled: "Connection is disabled. Re-enable in settings.",
};

export type PlatformConnectionHealth = "healthy" | "warning" | "broken";

export const HEALTH_LABELS: Record<PlatformConnectionHealth, string> = {
  healthy: "Healthy",
  warning: "Needs attention",
  broken: "Broken",
};
