/**
 * Phase E2.8 — bridge signature helpers.
 *
 * The minimum viable approach is nonce-based replay protection:
 *   1. Signal generates a unique `nonce` at request creation.
 *   2. Operator returns the nonce verbatim in the result envelope.
 *   3. Signal verifies the nonce row is active and matches the workspace.
 *
 * HMAC signing remains an option for later phases. When
 * `OPERATOR_BRIDGE_SECRET` is set, callers can sign result envelopes
 * and Signal will verify the signature in addition to the nonce check.
 */

import { webcrypto } from "node:crypto";

function base64UrlEncode(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  webcrypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface SignableEnvelope {
  request_id: string;
  nonce: string;
  status: string;
  summary: string;
}

/**
 * Compute a deterministic canonical string from the parts we sign.
 * Sort keys to keep the signature stable across re-encodings.
 */
export function canonicalString(envelope: SignableEnvelope): string {
  return [
    `request_id=${envelope.request_id}`,
    `nonce=${envelope.nonce}`,
    `status=${envelope.status}`,
    `summary=${envelope.summary}`,
  ].join("&");
}

/**
 * Compute the HMAC-SHA256 of the canonical string with the shared
 * secret. Returns null when no secret is configured — callers should
 * treat null as "signing not configured" and rely on nonce-only
 * verification.
 */
export async function computeSignature(
  envelope: SignableEnvelope,
  secret: string | null,
): Promise<string | null> {
  if (!secret) return null;
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await webcrypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalString(envelope)),
    ),
  );
  return base64UrlEncode(bytes);
}

export async function verifySignature(
  envelope: SignableEnvelope,
  signature: string,
  secret: string | null,
): Promise<boolean> {
  if (!secret) return false;
  const expected = await computeSignature(envelope, secret);
  if (!expected) return false;
  if (expected.length !== signature.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
