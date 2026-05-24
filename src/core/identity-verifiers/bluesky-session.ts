/**
 * Bluesky app-password session connector.
 *
 * This is the ownership-proving flow for Bluesky identities. It
 * accepts a Bluesky App Password (NOT the operator's main account
 * password) and exchanges it for an authenticated session via the AT
 * Protocol `com.atproto.server.createSession` endpoint.
 *
 * Endpoint:
 *   POST https://bsky.social/xrpc/com.atproto.server.createSession
 *   body: { identifier, password }
 *   200  → { did, handle, accessJwt, refreshJwt, ... }
 *   401  → { error: "AuthenticationRequired" }   — bad credentials
 *   400  → { error: "InvalidRequest", message }  — malformed
 *
 * What this PROVES:
 *   - The credential is valid right now
 *   - It belongs to a specific DID
 *   - Signal can mint a session JWT for posting as that DID
 *
 * The route that calls this then:
 *   1. Verifies the returned DID/handle matches the identity's
 *      declared handle (mismatch ⇒ refuse to mark connected).
 *   2. Encrypts the access + refresh JWTs with TOKEN_ENCRYPTION_KEY
 *      (AES-256-GCM, same path as OAuth tokens).
 *   3. Upserts the platform_connections row with the encrypted
 *      tokens and connection_status='connected'.
 *
 * Security posture:
 *   - App password is taken as input, used once, and never returned.
 *   - The verifier NEVER logs the password or its length.
 *   - The verifier never echoes the password in any return value.
 *   - The route is responsible for handling the password without
 *     persisting it. This module does not persist anything itself.
 *   - All access/refresh JWTs are returned in the result so the
 *     route can encrypt them, but they MUST NOT be logged, echoed
 *     to the client, or stored unencrypted.
 *
 * Pure function. No I/O outside the injected `fetchImpl`. No state.
 */

import { isValidBlueskyHandle, normalizeBlueskyHandle } from "./bluesky-resolve";

/**
 * The createSession endpoint lives on the PDS, not on the public
 * AppView. bsky.social is the canonical Bluesky-operated PDS.
 * Self-hosted PDS users could theoretically resolve to a different
 * host; that's out of scope here — Signal assumes bsky.social-class
 * PDSes for the MVP.
 */
const BLUESKY_PDS = "https://bsky.social";

export interface BlueskySessionInput {
  identityId: string;
  workspaceId: string;
  /**
   * The handle the operator declared on the identity row. Compared
   * against the handle the createSession response returns.
   */
  declaredHandle: string;
  /**
   * Identifier sent to createSession. Usually the same as
   * declaredHandle (normalized), but the API also accepts emails.
   * The session response carries the authoritative handle/DID we
   * verify against.
   */
  identifier: string;
  /**
   * The Bluesky App Password. Used once, never stored, never logged,
   * never returned. The route holds this in memory only for the
   * duration of the call.
   */
  appPassword: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export type BlueskySessionErrorCode =
  | "handle_invalid"
  | "identifier_invalid"
  | "credentials_missing"
  | "auth_failed"
  | "provider_error"
  | "network_error";

/**
 * Authenticated session — caller has proved ownership of the DID.
 * The route encrypts the JWTs before persisting.
 */
export interface BlueskySessionConnected {
  outcome: "connected";
  providerAccountId: string; // DID
  authenticatedHandle: string;
  /**
   * Raw JWTs returned by createSession. The route MUST encrypt
   * before persisting. These never leave the route boundary in
   * plaintext.
   */
  accessJwt: string;
  refreshJwt: string;
}

/**
 * Credentials authenticated, but the resulting DID/handle does not
 * match the identity's declared handle. The route writes a
 * connection row with connection_status='error' and
 * metadata.handle_mismatch — same shape used by the OAuth callback.
 * The encrypted tokens are NOT persisted (we won't publish under
 * the wrong account).
 */
export interface BlueskySessionMismatched {
  outcome: "mismatched";
  declaredHandle: string;
  authenticatedHandle: string;
  providerAccountId: string;
}

export interface BlueskySessionError {
  outcome: "error";
  code: BlueskySessionErrorCode;
  message: string;
}

export type BlueskySessionResult =
  | BlueskySessionConnected
  | BlueskySessionMismatched
  | BlueskySessionError;

export async function connectBlueskyWithAppPassword(
  input: BlueskySessionInput,
): Promise<BlueskySessionResult> {
  // ── Input validation ───────────────────────────────────────────
  const declared = normalizeBlueskyHandle(input.declaredHandle);
  if (!declared || !isValidBlueskyHandle(declared)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message:
        "Identity's declared handle is missing or malformed. Fix it before connecting.",
    };
  }
  const identifier = (input.identifier ?? "").trim();
  if (identifier.length === 0) {
    return {
      outcome: "error",
      code: "identifier_invalid",
      message: "Bluesky identifier (handle or email) is required.",
    };
  }
  // Password length check, not value — the value MUST NOT appear in
  // any error message, log line, or return value.
  if (
    typeof input.appPassword !== "string" ||
    input.appPassword.length === 0
  ) {
    return {
      outcome: "error",
      code: "credentials_missing",
      message: "Bluesky App Password is required.",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  // ── createSession ──────────────────────────────────────────────
  let sessionBody: Record<string, unknown>;
  try {
    const res = await doFetch(`${BLUESKY_PDS}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier,
        password: input.appPassword,
      }),
    });

    if (res.status === 401) {
      // Bad credentials. Do NOT echo the password or its length.
      return {
        outcome: "error",
        code: "auth_failed",
        message:
          "Bluesky rejected the credentials. Double-check the handle and App Password.",
      };
    }
    if (res.status === 400) {
      const body = (await safeJson(res)) ?? {};
      const code = typeof body.error === "string" ? body.error : null;
      return {
        outcome: "error",
        code: "provider_error",
        message: `Bluesky returned 400${code ? ` (${code})` : ""}.`,
      };
    }
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Bluesky createSession failed: HTTP ${res.status}.`,
      };
    }
    sessionBody = (await safeJson(res)) ?? {};
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Bluesky: ${(err as Error).message ?? "unknown"}.`,
    };
  }

  // ── Validate response shape ───────────────────────────────────
  const did = typeof sessionBody.did === "string" ? sessionBody.did : null;
  const handle =
    typeof sessionBody.handle === "string" ? sessionBody.handle : null;
  const accessJwt =
    typeof sessionBody.accessJwt === "string" ? sessionBody.accessJwt : null;
  const refreshJwt =
    typeof sessionBody.refreshJwt === "string" ? sessionBody.refreshJwt : null;

  if (!did || !did.startsWith("did:") || !handle || !accessJwt || !refreshJwt) {
    return {
      outcome: "error",
      code: "provider_error",
      message:
        "Bluesky createSession returned an unexpected response shape (missing did/handle/accessJwt/refreshJwt).",
    };
  }

  // ── Handle/DID match check ────────────────────────────────────
  const authenticatedNormalized = normalizeBlueskyHandle(handle);
  if (!authenticatedNormalized || authenticatedNormalized !== declared) {
    return {
      outcome: "mismatched",
      declaredHandle: input.declaredHandle,
      authenticatedHandle: handle,
      providerAccountId: did,
    };
  }

  return {
    outcome: "connected",
    providerAccountId: did,
    authenticatedHandle: authenticatedNormalized,
    accessJwt,
    refreshJwt,
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
