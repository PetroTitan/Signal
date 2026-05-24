/**
 * Phase F2 — token storage helpers.
 *
 * This is the *only* module that handles raw plaintext tokens after
 * they leave the provider's token endpoint. Every other module
 * either (a) consumes the encrypted envelope or (b) gets back a
 * decrypted token through `decryptForOutboundUse` which is reserved
 * for server-only outbound API calls.
 *
 * Rules:
 *   - never log plaintext tokens
 *   - never log key material
 *   - never return plaintext to client-facing code paths
 *   - never store a plaintext fallback
 */

import "server-only";
import { getTokenCipher } from "./token-encryption";
import { composeTokenPersistence, type TokenResponse } from "./token-lifecycle";
import type { ConnectionPlatform } from "./oauth-types";

export interface EncryptedTokens {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: string | null;
  scopes: string[];
}

export interface EncryptedTokensFailure {
  ok: false;
  reason: string;
}

export type EncryptTokensResult =
  | ({ ok: true } & EncryptedTokens)
  | EncryptedTokensFailure;

/**
 * Encrypt an OAuth token response. Returns a discriminated union
 * the caller can `if (!result.ok)` on. Never throws — refusal is a
 * normal flow that surfaces as a connection_status='error' record.
 */
export function encryptTokenResponse(input: {
  platform: ConnectionPlatform;
  response: TokenResponse;
}): EncryptTokensResult {
  const cipher = getTokenCipher();
  const persisted = composeTokenPersistence({
    platform: input.platform,
    response: input.response,
    cipher,
  });
  if (!persisted.ok || !persisted.accessTokenEncrypted) {
    return {
      ok: false,
      reason: persisted.reason ?? "token_storage_unavailable",
    };
  }
  return {
    ok: true,
    accessTokenEncrypted: persisted.accessTokenEncrypted,
    refreshTokenEncrypted: persisted.refreshTokenEncrypted,
    expiresAt: persisted.expiresAt,
    scopes: input.response.scopes,
  };
}

/**
 * Decrypt an encrypted-token envelope for an outbound API call.
 *
 * Returns null when the cipher refuses (envelope corrupt, key missing,
 * wrong version). Caller MUST treat null as "block, do not call the
 * platform" — never fall back to the encrypted string.
 *
 * The returned plaintext should never be persisted, logged, or
 * returned to client-facing code paths. Hold it for the duration of
 * the outbound request and discard.
 */
export function decryptForOutboundUse(envelope: string | null): string | null {
  if (!envelope) return null;
  const cipher = getTokenCipher();
  if (!cipher.isAvailable()) return null;
  return cipher.decrypt(envelope);
}

/**
 * Compute a non-reversible fingerprint of a plaintext token for log
 * correlation, *if* you really must. Returns a short prefix of the
 * SHA-256 hash; the original token cannot be recovered from this.
 * Used by the verification check, never by the publisher.
 */
export async function tokenFingerprint(plaintext: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(plaintext, "utf8")
    .digest("hex")
    .slice(0, 12);
}
