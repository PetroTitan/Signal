import type {
  ConnectionDegradationMode,
  PlatformConnectionHealth,
  PlatformConnectionStatus,
} from "./connection-status";
import type {
  PlatformCapability,
  SupportedChannel,
} from "./platform-capabilities";
import type { ConnectionHealthRecord } from "./connection-health";

export const PLATFORM_CONNECTION_SCHEMA_VERSION = 1;

export interface PlatformConnection {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  channel: SupportedChannel;
  accountId: string | null;
  accountHandle: string | null;
  displayName: string | null;
  connectionStatus: PlatformConnectionStatus;
  scopes: string[];
  connectedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastCheckedAt: string | null;
  healthStatus: PlatformConnectionHealth;
  capabilities: PlatformCapability[];
  health: ConnectionHealthRecord;
  degradationMode: ConnectionDegradationMode;
  recoveryAction: string | null;
}

export type PlatformConnectionSummary = Pick<
  PlatformConnection,
  | "channel"
  | "connectionStatus"
  | "displayName"
  | "accountHandle"
  | "healthStatus"
>;
