export const CONNECTION_STATUSES = [
  "not_connected",
  "ready_to_connect",
  "pending_authorization",
  "connected",
  "healthy",
  "degraded",
  "expired",
  "revoked",
  "reauthorization_required",
  "disabled",
  "error",
] as const;

export type PlatformConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<PlatformConnectionStatus, string> = {
  not_connected: "Not connected",
  ready_to_connect: "Ready to connect",
  pending_authorization: "Awaiting authorization",
  connected: "Connected",
  healthy: "Healthy",
  degraded: "Degraded",
  expired: "Expired",
  revoked: "Revoked",
  reauthorization_required: "Reauthorization required",
  disabled: "Disabled",
  error: "Connection error",
};

export const CONNECTION_STATUS_USER_HINTS: Record<PlatformConnectionStatus, string> = {
  not_connected:
    "Create the account on the platform first, then connect through official OAuth.",
  ready_to_connect:
    "Account is set up. Connect through official OAuth when integrations ship.",
  pending_authorization:
    "Finish the platform authorization step to complete the connection.",
  connected:
    "Signal can read what you've allowed. You still approve everything.",
  healthy:
    "Connection is healthy. Signal will keep refreshing the token automatically.",
  degraded:
    "Connection is reachable but partial. Signal will continue in draft-only mode.",
  expired:
    "Reauthorize to continue using this connection. Drafts and schedules are preserved.",
  revoked:
    "You revoked this connection. Reconnect when you're ready.",
  reauthorization_required:
    "The platform requires you to reauthorize. Drafts are preserved.",
  disabled:
    "Connection is disabled in settings. Re-enable to resume.",
  error:
    "Signal hit an error reaching this platform. Drafts are preserved; retry later.",
};

export type PlatformConnectionHealth = "healthy" | "warning" | "broken";

export const HEALTH_LABELS: Record<PlatformConnectionHealth, string> = {
  healthy: "Healthy",
  warning: "Needs attention",
  broken: "Broken",
};

export type ConnectionDegradationMode =
  | "none"
  | "draft_only"
  | "read_only"
  | "paused";

export const DEGRADATION_MODE_LABELS: Record<ConnectionDegradationMode, string> = {
  none: "Full",
  draft_only: "Draft-only",
  read_only: "Read-only",
  paused: "Paused",
};

export const HEALTHY_STATUSES: PlatformConnectionStatus[] = [
  "connected",
  "healthy",
];

export const NEEDS_USER_ACTION_STATUSES: PlatformConnectionStatus[] = [
  "expired",
  "revoked",
  "reauthorization_required",
  "error",
];

export const PUBLISHING_BLOCKED_STATUSES: PlatformConnectionStatus[] = [
  "not_connected",
  "ready_to_connect",
  "pending_authorization",
  "degraded",
  "expired",
  "revoked",
  "reauthorization_required",
  "disabled",
  "error",
];

export function isHealthy(status: PlatformConnectionStatus): boolean {
  return HEALTHY_STATUSES.includes(status);
}

export function needsUserAction(status: PlatformConnectionStatus): boolean {
  return NEEDS_USER_ACTION_STATUSES.includes(status);
}

export function publishingAllowed(status: PlatformConnectionStatus): boolean {
  return !PUBLISHING_BLOCKED_STATUSES.includes(status);
}
