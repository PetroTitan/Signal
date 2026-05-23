/**
 * Phase F2 — AES-256-GCM token cipher.
 *
 * The cipher is fail-closed: if TOKEN_ENCRYPTION_KEY is missing,
 * malformed, or the wrong length, every caller gets a no-op cipher
 * that refuses to encrypt and refuses to decrypt. There is no
 * plaintext fallback. There is no key derivation. There is no
 * silent downgrade.
 *
 * Ciphertext envelope (single string):
 *   v1:<iv_b64u>:<tag_b64u>:<ciphertext_b64u>
 *
 * Where each segment is base64url (no padding). IV is 12 bytes
 * (96 bits), the GCM auth tag is 16 bytes, and the ciphertext is the
 * UTF-8 plaintext encrypted with AES-256-GCM. The `v1:` prefix lets
 * us rotate the algorithm later by branching on the version.
 */

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TokenCipher } from "./token-lifecycle";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

export interface AesGcmCipherOptions {
  /** Raw 32-byte key. Caller is responsible for sourcing it. */
  key: Buffer;
  /** Human-readable description for logs and UX. Never the key. */
  describe: string;
}

/**
 * Build a real cipher backed by AES-256-GCM. The constructor never
 * stores or logs the key beyond the closure. Callers should resolve
 * the cipher once at module load and pass it around as a `TokenCipher`.
 */
export function createAesGcmCipher(options: AesGcmCipherOptions): TokenCipher {
  if (options.key.length !== KEY_BYTES) {
    throw new Error(
      `token cipher: key must be ${KEY_BYTES} bytes, got ${options.key.length}`,
    );
  }
  const keyCopy = Buffer.from(options.key); // do not retain the caller's buffer

  return {
    isAvailable: () => true,
    describe: () => options.describe,

    encrypt(plaintext: string): string | null {
      if (typeof plaintext !== "string" || plaintext.length === 0) return null;
      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", keyCopy, iv);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, "utf8"),
          cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return [
          ENVELOPE_VERSION,
          iv.toString("base64url"),
          tag.toString("base64url"),
          ciphertext.toString("base64url"),
        ].join(":");
      } catch {
        return null;
      }
    },

    decrypt(envelope: string): string | null {
      if (typeof envelope !== "string" || envelope.length === 0) return null;
      const parts = envelope.split(":");
      if (parts.length !== 4) return null;
      const [version, ivB64, tagB64, ctB64] = parts;
      if (version !== ENVELOPE_VERSION) return null;
      try {
        const iv = Buffer.from(ivB64, "base64url");
        const tag = Buffer.from(tagB64, "base64url");
        const ct = Buffer.from(ctB64, "base64url");
        if (iv.length !== IV_BYTES) return null;
        if (tag.length !== TAG_BYTES) return null;
        const decipher = createDecipheriv("aes-256-gcm", keyCopy, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Parse a TOKEN_ENCRYPTION_KEY env value. Accepts base64url (no
 * padding) OR standard base64. Returns null if the value decodes to
 * anything other than exactly KEY_BYTES bytes.
 */
export function parseKeyFromEnv(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Try base64url first, then standard base64. Both forms decode to
  // the same bytes for ASCII-clean keys, so the order is mostly a
  // matter of which alphabet the operator pasted.
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const buf = Buffer.from(trimmed, encoding);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      // try the next encoding
    }
  }
  return null;
}
