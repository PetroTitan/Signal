import "server-only";
import { webcrypto } from "node:crypto";
import { McpError } from "./errors";

/**
 * Phase F0 — token format + hashing.
 *
 * Plaintext token layout: `sigt_<base64url(32 random bytes)>`.
 * Length is fixed at the prefix + 43 chars of base64url (no padding).
 * SHA-256 hash of the full plaintext lives in the DB; the plaintext is
 * shown to the operator exactly once.
 */

const TOKEN_PREFIX = "sigt_";

function base64UrlEncode(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function mintPlaintextToken(): string {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${base64UrlEncode(bytes)}`;
}

export function tokenPreview(plaintext: string): string {
  // First 8 chars of the post-prefix random portion.
  return plaintext.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8);
}

export async function hashToken(plaintext: string): Promise<string> {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export function isValidTokenShape(s: string): boolean {
  if (!s.startsWith(TOKEN_PREFIX)) return false;
  const rest = s.slice(TOKEN_PREFIX.length);
  return rest.length >= 32 && /^[A-Za-z0-9_-]+$/.test(rest);
}

/**
 * Extract the bearer token from the Authorization header. Throws
 * McpError on missing / malformed headers.
 */
export function extractBearer(authorization: string | null): string {
  if (!authorization) {
    throw new McpError(
      "missing_authorization",
      "Authorization header missing.",
      401,
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    throw new McpError(
      "missing_authorization",
      "Authorization header must be 'Bearer <token>'.",
      401,
    );
  }
  const token = match[1].trim();
  if (!isValidTokenShape(token)) {
    throw new McpError("invalid_token", "Bearer token format is invalid.", 401);
  }
  return token;
}
