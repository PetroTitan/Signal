/**
 * State + PKCE helpers used by the OAuth start route.
 *
 * The state token binds (state, user, workspace, platform) and lives
 * in `oauth_state_tokens` until the callback consumes it. It is
 * short-lived (10 minutes by table default) and consumed exactly once.
 */

import { webcrypto } from "node:crypto";

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  webcrypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await webcrypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function isStateExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
