import "server-only";
/**
 * Phase F4 — tier-1 platform credentials.
 *
 * dev.to, Hashnode, and Bluesky use simple API tokens / app-passwords
 * rather than OAuth. We read them from the environment, never log
 * them, and never persist them into the request payload that gets
 * recorded in publish_history.metadata.
 *
 * Reddit / X / LinkedIn keep their OAuth flow — those credentials
 * live in the `platform_connections` table.
 */

import type { PublishPlatform } from "./publishing-types";

export interface DevtoCredentials {
  platform: "devto";
  apiKey: string;
}

export interface HashnodeCredentials {
  platform: "hashnode";
  apiKey: string;
  publicationId: string;
}

export interface BlueskyCredentials {
  platform: "bluesky";
  identifier: string;
  appPassword: string;
  /** Defaults to "https://bsky.social"; can be overridden for self-hosted PDS. */
  service: string;
}

export type TierOneCredentials =
  | DevtoCredentials
  | HashnodeCredentials
  | BlueskyCredentials;

function safe(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readDevtoCredentials(): DevtoCredentials | null {
  const apiKey = safe(process.env.DEVTO_API_KEY);
  if (!apiKey) return null;
  return { platform: "devto", apiKey };
}

export function readHashnodeCredentials(): HashnodeCredentials | null {
  const apiKey = safe(process.env.HASHNODE_API_KEY);
  const publicationId = safe(process.env.HASHNODE_PUBLICATION_ID);
  if (!apiKey || !publicationId) return null;
  return { platform: "hashnode", apiKey, publicationId };
}

export function readBlueskyCredentials(): BlueskyCredentials | null {
  const identifier = safe(process.env.BLUESKY_IDENTIFIER);
  const appPassword = safe(process.env.BLUESKY_APP_PASSWORD);
  if (!identifier || !appPassword) return null;
  return {
    platform: "bluesky",
    identifier,
    appPassword,
    service: safe(process.env.BLUESKY_SERVICE) ?? "https://bsky.social",
  };
}

/**
 * Surfaces whether each tier-1 platform is configured, without
 * leaking the actual values. Safe to render in admin UIs.
 */
export interface TierOneConfigStatus {
  devto: { configured: boolean };
  hashnode: { configured: boolean; hasPublicationId: boolean };
  bluesky: { configured: boolean };
}

export function readTierOneConfigStatus(): TierOneConfigStatus {
  return {
    devto: { configured: readDevtoCredentials() !== null },
    hashnode: {
      configured: readHashnodeCredentials() !== null,
      hasPublicationId: !!safe(process.env.HASHNODE_PUBLICATION_ID),
    },
    bluesky: { configured: readBlueskyCredentials() !== null },
  };
}

/**
 * Map a platform to a friendly env-variable hint for the operator —
 * used in error messages so the operator knows what to set.
 */
export function credentialEnvHint(platform: PublishPlatform): string {
  switch (platform) {
    case "devto":
      return "DEVTO_API_KEY";
    case "hashnode":
      return "HASHNODE_API_KEY (and HASHNODE_PUBLICATION_ID)";
    case "bluesky":
      return "BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD";
    case "reddit":
    case "x":
    case "linkedin":
      return "OAuth connection on /accounts";
  }
}
