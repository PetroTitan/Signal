import type { SupportedRegion } from "./workspace-region";

export const NETWORK_PROFILE_SCHEMA_VERSION = 1;

export const SUPPORTED_PROXY_PROTOCOLS = ["http", "https", "socks5"] as const;

export type ProxyProtocol = (typeof SUPPORTED_PROXY_PROTOCOLS)[number];

export const PROXY_PROTOCOL_LABELS: Record<ProxyProtocol, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks5: "SOCKS5",
};

/**
 * A workspace-level outbound network profile. This is stable regional routing,
 * not rotation. There is at most one active profile per workspace at a time.
 *
 * The plaintext credential is never present in the client. The UI receives only
 * `encryptedPasswordPlaceholder` (e.g. "***"); the real value lives encrypted
 * server-side and is decrypted only when making the outbound call.
 */
export interface NetworkProfile {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  label: string;
  region: SupportedRegion;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  encryptedPasswordPlaceholder: string | null;
  timezone: string;
  language: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const NETWORK_PROFILE_LIMITS = {
  labelMax: 60,
  hostMax: 253,
  usernameMax: 80,
  portMin: 1,
  portMax: 65535,
} as const;

/**
 * Masked summary safe to render in any UI surface. Never carries credentials.
 */
export interface NetworkProfileSummary {
  id: string;
  label: string;
  region: SupportedRegion;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  hasCredentials: boolean;
  active: boolean;
}
