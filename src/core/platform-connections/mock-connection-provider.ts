import type { PlatformConnection } from "./connection-types";
import type { SupportedChannel } from "./platform-capabilities";
import { PLATFORM_CAPABILITY_PROFILES } from "./platform-capabilities";
import { connectionError, type ConnectionError } from "./connection-errors";

export interface ConnectionProvider {
  list(workspaceId: string): Promise<PlatformConnection[]>;
  startConnect(
    workspaceId: string,
    channel: SupportedChannel,
  ): Promise<{ ok: false; error: ConnectionError }>;
  revoke(connectionId: string): Promise<{ ok: false; error: ConnectionError }>;
}

const CHANNELS: SupportedChannel[] = ["reddit", "x", "linkedin", "google"];

export class MockConnectionProvider implements ConnectionProvider {
  async list(workspaceId: string): Promise<PlatformConnection[]> {
    return CHANNELS.map((channel) => buildPlaceholder(workspaceId, channel));
  }

  async startConnect(): Promise<{ ok: false; error: ConnectionError }> {
    return { ok: false, error: connectionError("not_implemented") };
  }

  async revoke(): Promise<{ ok: false; error: ConnectionError }> {
    return { ok: false, error: connectionError("not_implemented") };
  }
}

function buildPlaceholder(
  workspaceId: string,
  channel: SupportedChannel,
): PlatformConnection {
  const profile = PLATFORM_CAPABILITY_PROFILES[channel];
  return {
    id: `conn_${channel}`,
    workspaceId,
    channel,
    accountId: null,
    accountHandle: null,
    displayName: null,
    connectionStatus: "not_connected",
    scopes: [],
    connectedAt: null,
    expiresAt: null,
    revokedAt: null,
    lastCheckedAt: null,
    healthStatus: "healthy",
    capabilities: profile.capabilities
      .filter((c) => c.state === "available")
      .map((c) => c.capability),
  };
}
