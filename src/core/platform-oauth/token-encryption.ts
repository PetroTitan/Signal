/**
 * Phase F2 — env-side cipher resolution.
 *
 * Reads TOKEN_ENCRYPTION_KEY exactly once at module load. If the key
 * is missing or malformed, every subsequent caller gets the no-op
 * cipher and the rest of the OAuth pipeline records the connection
 * as `error` with metadata.token_storage='not_configured' — the same
 * behavior the Phase E3 scaffolding promised.
 *
 * Key requirements:
 *   - server-only env (never NEXT_PUBLIC_)
 *   - base64url or base64 of exactly 32 bytes (AES-256)
 *   - never logged
 */

import "server-only";
import { NOOP_CIPHER, type TokenCipher } from "./token-lifecycle";
import { createAesGcmCipher, parseKeyFromEnv } from "./token-cipher";

interface CipherDiagnostic {
  status: "configured" | "missing" | "invalid";
  /** Operator-readable detail; safe to surface in UI. Never the key. */
  message: string;
}

let _cipher: TokenCipher | null = null;
let _diagnostic: CipherDiagnostic | null = null;

function build(): { cipher: TokenCipher; diagnostic: CipherDiagnostic } {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    return {
      cipher: NOOP_CIPHER,
      diagnostic: {
        status: "missing",
        message:
          "Token encryption is not configured. Set TOKEN_ENCRYPTION_KEY (32-byte base64url) and redeploy.",
      },
    };
  }
  const key = parseKeyFromEnv(raw);
  if (!key) {
    return {
      cipher: NOOP_CIPHER,
      diagnostic: {
        status: "invalid",
        message:
          "TOKEN_ENCRYPTION_KEY is set but does not decode to exactly 32 bytes. Regenerate with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"`.",
      },
    };
  }
  try {
    const cipher = createAesGcmCipher({
      key,
      describe: "aes-256-gcm",
    });
    // Self-test: encrypt + decrypt a known string. Refuses to ship a
    // cipher that can't round-trip — much better than discovering it
    // at the first real OAuth callback.
    const probe = cipher.encrypt("__signal_cipher_self_test__");
    if (!probe || cipher.decrypt(probe) !== "__signal_cipher_self_test__") {
      return {
        cipher: NOOP_CIPHER,
        diagnostic: {
          status: "invalid",
          message: "Cipher self-test failed. Token encryption is disabled.",
        },
      };
    }
    return {
      cipher,
      diagnostic: {
        status: "configured",
        message: "Token encryption configured (AES-256-GCM, v1 envelope).",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      cipher: NOOP_CIPHER,
      diagnostic: {
        status: "invalid",
        message: `Failed to initialize cipher: ${msg}`,
      },
    };
  }
}

function ensure(): void {
  if (_cipher) return;
  const built = build();
  _cipher = built.cipher;
  _diagnostic = built.diagnostic;
}

/**
 * Returns the configured token cipher. Always succeeds — the no-op
 * cipher is returned when the key isn't configured. Use
 * `cipher.isAvailable()` to gate persistence and surfacing in UI.
 */
export function getTokenCipher(): TokenCipher {
  ensure();
  return _cipher as TokenCipher;
}

/**
 * Operator-facing diagnostic (status + message). The UI uses this to
 * surface "Token encryption not configured" / "Invalid key" without
 * leaking key material.
 */
export function getTokenCipherDiagnostic(): CipherDiagnostic {
  ensure();
  return _diagnostic as CipherDiagnostic;
}

/**
 * Test-only: forget the cached cipher. Not used in production code
 * paths; here so unit tests can swap the env between cases without
 * spawning a new process.
 */
export function resetTokenCipherCacheForTests(): void {
  _cipher = null;
  _diagnostic = null;
}
