import type {
  ConnectionDegradationMode,
  PlatformConnectionStatus,
} from "./connection-status";

export const CONNECTION_HEALTH_SCHEMA_VERSION = 1;

export interface ConnectionHealthRecord {
  schemaVersion: number;
  connectionId: string;
  lastSuccessfulSyncAt: string | null;
  lastFailedSyncAt: string | null;
  failedSyncCount: number;
  refreshExpiresAt: string | null;
  recoveryAction: string | null;
  degradationMode: ConnectionDegradationMode;
}

export const DEFAULT_HEALTH_RECORD: Omit<ConnectionHealthRecord, "connectionId"> = {
  schemaVersion: CONNECTION_HEALTH_SCHEMA_VERSION,
  lastSuccessfulSyncAt: null,
  lastFailedSyncAt: null,
  failedSyncCount: 0,
  refreshExpiresAt: null,
  recoveryAction: null,
  degradationMode: "none",
};

const REFRESH_WARNING_HOURS = 72;
const MAX_TRANSIENT_FAILURES = 3;

export interface DerivedConnectionState {
  status: PlatformConnectionStatus;
  degradationMode: ConnectionDegradationMode;
  recoveryAction: string | null;
}

export function deriveConnectionState(
  status: PlatformConnectionStatus,
  health: ConnectionHealthRecord,
  now: Date = new Date(),
): DerivedConnectionState {
  if (status === "revoked" || status === "expired" || status === "reauthorization_required") {
    return {
      status,
      degradationMode: "draft_only",
      recoveryAction: "Reauthorize through official OAuth to resume publishing.",
    };
  }
  if (status === "disabled") {
    return {
      status,
      degradationMode: "paused",
      recoveryAction: "Re-enable this connection in settings.",
    };
  }
  if (status === "error" || health.failedSyncCount >= MAX_TRANSIENT_FAILURES) {
    return {
      status: status === "error" ? "error" : "degraded",
      degradationMode: "draft_only",
      recoveryAction:
        "Signal is in draft-only mode for this account. Drafts are preserved; retry later.",
    };
  }
  if (health.refreshExpiresAt) {
    const expires = Date.parse(health.refreshExpiresAt);
    if (!Number.isNaN(expires)) {
      const hoursLeft = (expires - now.getTime()) / (1000 * 60 * 60);
      if (hoursLeft <= 0) {
        return {
          status: "expired",
          degradationMode: "draft_only",
          recoveryAction: "Token expired. Reauthorize to resume.",
        };
      }
      if (hoursLeft <= REFRESH_WARNING_HOURS) {
        return {
          status: "degraded",
          degradationMode: "draft_only",
          recoveryAction:
            "Token will expire soon. Reauthorize at your next session.",
        };
      }
    }
  }
  return {
    status,
    degradationMode: "none",
    recoveryAction: null,
  };
}

export const SELF_HEALING_RULES = [
  "Refresh tokens are attempted before each sync if available.",
  "After 3 consecutive failed syncs, the connection enters degraded mode.",
  "Degraded mode preserves drafts and schedules; publishing is paused.",
  "User reauthorization is the only manual recovery action ever surfaced.",
  "Signal never retries aggressively; backoff is bounded.",
] as const;
