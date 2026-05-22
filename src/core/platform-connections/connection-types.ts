import type { PlatformConnectionHealth, PlatformConnectionStatus } from "./connection-status";
import type {
  PlatformCapability,
  SupportedChannel,
} from "./platform-capabilities";

export interface PlatformConnection {
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
}

export type PlatformConnectionSummary = Pick<
  PlatformConnection,
  | "channel"
  | "connectionStatus"
  | "displayName"
  | "accountHandle"
  | "healthStatus"
>;
