/**
 * Token-lifecycle helpers.
 *
 * Phase E3 does NOT encrypt or store real tokens unless the runtime
 * has the encryption layer wired. The default `noop` cipher refuses
 * to encrypt — it returns null and the caller surfaces
 * `token_storage_unavailable`.
 *
 * The contract is:
 *
 *   encrypt(plaintext) → string | null
 *
 * The repository never stores `null` for a "successful" connection.
 * If encryption returns null and the operator still finishes the
 * OAuth flow, the connection is recorded with `connection_status =
 * 'error'` and `metadata.token_storage = 'not_configured'`.
 */

import type { OAuthPlatform } from "./oauth-types";

export interface TokenCipher {
  encrypt(plaintext: string): string | null;
  decrypt(ciphertext: string): string | null;
  isAvailable(): boolean;
  describe(): string;
}

/**
 * Default cipher. Returns null on every call; the runtime surfaces
 * `token_storage_unavailable` to callers that try to persist a real
 * token. This makes "encryption not wired" a *hard error*, not a
 * silent downgrade.
 */
export const NOOP_CIPHER: TokenCipher = {
  encrypt: () => null,
  decrypt: () => null,
  isAvailable: () => false,
  describe: () => "noop (encryption not configured)",
};

/**
 * Cipher resolver. A future PR can swap this for an AES-GCM cipher
 * backed by a KMS-managed key. Until then the noop is the only
 * option.
 */
export function resolveTokenCipher(): TokenCipher {
  return NOOP_CIPHER;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until expiry, as returned by the provider. */
  expiresInSeconds: number | null;
  scopes: string[];
}

/**
 * Pure: compute the persistence shape from a provider response
 * without writing anything. Returns null if the cipher refuses to
 * encrypt the access token — the caller must surface that and not
 * mark the connection as connected.
 */
export function composeTokenPersistence(input: {
  platform: OAuthPlatform;
  response: TokenResponse;
  cipher: TokenCipher;
}): {
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  expiresAt: string | null;
  ok: boolean;
  reason?: string;
} {
  if (!input.cipher.isAvailable()) {
    return {
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      ok: false,
      reason: `Cipher ${input.cipher.describe()} cannot encrypt — refusing to store plaintext.`,
    };
  }
  const accessEnc = input.cipher.encrypt(input.response.accessToken);
  if (!accessEnc) {
    return {
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      ok: false,
      reason: "Access-token encryption returned null.",
    };
  }
  const refreshEnc = input.response.refreshToken
    ? input.cipher.encrypt(input.response.refreshToken)
    : null;
  const expiresAt =
    input.response.expiresInSeconds !== null
      ? new Date(
          Date.now() + input.response.expiresInSeconds * 1000,
        ).toISOString()
      : null;
  return {
    accessTokenEncrypted: accessEnc,
    refreshTokenEncrypted: refreshEnc,
    expiresAt,
    ok: true,
  };
}
