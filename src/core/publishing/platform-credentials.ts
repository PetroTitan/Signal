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

/**
 * F5.1 — Telegram Bot API token. The per-channel chat_id is stored
 * on each `growth_accounts.handle` row (founder enters @channelname
 * or numeric chat id when creating the identity), so a single workspace
 * bot can post to multiple channels the founder has explicitly added
 * it to as admin.
 */
export interface TelegramCredentials {
  platform: "telegram";
  botToken: string;
}

export type TierOneCredentials =
  | DevtoCredentials
  | HashnodeCredentials
  | BlueskyCredentials
  | TelegramCredentials;

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
 * Legacy workspace-level Bluesky fallback flag. Opt-in only —
 * defaults to false. When true AND the identity has no encrypted
 * session of its own AND BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD
 * are present, publishing falls back to the workspace-level
 * credentials.
 *
 * This is a transitional shim for workspaces that haven't yet
 * signed in to each Bluesky identity through the per-identity
 * Manage flow. It's expected to be removed once all live
 * identities have their own sessions; toggling it off in
 * production should be the default state and just leave the env
 * var unset.
 *
 * IMPORTANT: even when this flag is on, the fallback is platform-
 * wide, NOT identity-scoped. Posts will go through the workspace
 * credential's account — which may or may not be the same account
 * the identity expects. Use cautiously.
 */
export function isBlueskyLegacyFallbackEnabled(): boolean {
  const raw = safe(process.env.BLUESKY_LEGACY_FALLBACK);
  if (!raw) return false;
  return raw === "true" || raw === "1";
}

/**
 * Phase F7.1 — same opt-in pattern as Bluesky for dev.to. When this
 * flag is enabled AND a scheduled dev.to publish has no per-identity
 * encrypted API key, the publisher falls back to the workspace-
 * level `DEVTO_API_KEY` env var. Default off — production should
 * leave this unset so identities without a connected key fail fast
 * with `devto_token_missing` instead of silently using a shared
 * workspace token.
 */
export function isDevtoLegacyFallbackEnabled(): boolean {
  const raw = safe(process.env.DEVTO_LEGACY_FALLBACK);
  if (!raw) return false;
  return raw === "true" || raw === "1";
}

/**
 * Service URL for AT Protocol calls. Same default as
 * readBlueskyCredentials. Exposed so the identity-scoped publisher
 * can read it without requiring the workspace credentials to be set.
 */
export function readBlueskyServiceUrl(): string {
  return safe(process.env.BLUESKY_SERVICE) ?? "https://bsky.social";
}

export function readTelegramCredentials(): TelegramCredentials | null {
  const botToken = safe(process.env.TELEGRAM_BOT_TOKEN);
  if (!botToken) return null;
  return { platform: "telegram", botToken };
}

/**
 * Surfaces whether each tier-1 platform is configured, without
 * leaking the actual values. Safe to render in admin UIs.
 */
export interface TierOneConfigStatus {
  devto: { configured: boolean };
  hashnode: { configured: boolean; hasPublicationId: boolean };
  bluesky: { configured: boolean };
  telegram: { configured: boolean };
}

export function readTierOneConfigStatus(): TierOneConfigStatus {
  return {
    devto: { configured: readDevtoCredentials() !== null },
    hashnode: {
      configured: readHashnodeCredentials() !== null,
      hasPublicationId: !!safe(process.env.HASHNODE_PUBLICATION_ID),
    },
    bluesky: { configured: readBlueskyCredentials() !== null },
    telegram: { configured: readTelegramCredentials() !== null },
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
    case "telegram":
      return "TELEGRAM_BOT_TOKEN (bot must be admin of the target channel)";
    case "reddit":
    case "x":
    case "linkedin":
      return "OAuth connection on /accounts";
    case "youtube":
    case "threads":
    case "instagram":
      return "Manual publishing — no API credentials needed";
  }
}
