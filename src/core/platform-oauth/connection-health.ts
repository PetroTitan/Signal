/**
 * Connection-health evaluation.
 *
 * Phase E3 has no automatic refresh and no scheduled probes. The
 * operator clicks "Check connection" and the health route returns
 * a verdict derived from local state only (status, expiry, last
 * check). When real provider probes arrive, extend
 * `evaluateConnectionHealth` to call the provider's profile
 * endpoint.
 */

import type {
  PlatformConnection,
  PlatformConnectionConnectionStatus,
  PlatformConnectionHealthStatus,
} from "./oauth-types";

export interface HealthVerdict {
  status: PlatformConnectionHealthStatus;
  connectionStatus: PlatformConnectionConnectionStatus;
  message: string;
}

export function evaluateConnectionHealth(
  conn: PlatformConnection,
): HealthVerdict {
  if (conn.connectionStatus === "revoked") {
    return {
      status: "revoked",
      connectionStatus: "revoked",
      message: "Connection was revoked.",
    };
  }
  if (conn.connectionStatus === "disabled") {
    return {
      status: "unknown",
      connectionStatus: "disabled",
      message: "Connection is disabled in settings.",
    };
  }
  if (conn.connectionStatus === "not_connected") {
    return {
      status: "unknown",
      connectionStatus: "not_connected",
      message: "Account is not connected via OAuth yet.",
    };
  }
  if (conn.expiresAt && new Date(conn.expiresAt).getTime() < Date.now()) {
    return {
      status: "expired",
      connectionStatus: "expired",
      message: "Token expired. Reauthorize to continue.",
    };
  }
  if (!conn.hasAccessToken) {
    return {
      status: "degraded",
      connectionStatus: "reauthorization_required",
      message:
        "Connection record exists but the access token is missing (likely token-storage was not configured at connect time). Reauthorize to restore.",
    };
  }
  if (
    conn.connectionStatus === "error" ||
    conn.connectionStatus === "reauthorization_required"
  ) {
    return {
      status: "degraded",
      connectionStatus: conn.connectionStatus,
      message: "Connection is in a recoverable error state.",
    };
  }
  return {
    status: "healthy",
    connectionStatus: "connected",
    message: "Connection looks healthy from local state. (No live probe yet.)",
  };
}
