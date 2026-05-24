/**
 * dev.to identity verifier.
 *
 * Ownership-proving flow for dev.to identities. Each identity gets
 * its own dev.to API key (one key = one account). The verifier
 * sends the key to GET /api/users/me; the response carries the
 * authoritative `username` + `id`. We verify the username matches
 * the identity's declared handle, then persist the key encrypted.
 *
 * Endpoint:
 *   GET https://dev.to/api/users/me
 *   headers: { "api-key": "<key>" }
 *   200 → { id, username, name, ... }
 *   401 → bad/missing key
 *   404 → endpoint not found (provider-side regression)
 *   other → provider_error
 *
 * Security posture:
 *   - The API key is taken as input, used once, never returned in
 *     the result. Encryption + persistence happen at the
 *     persistence helper / route layer.
 *   - No Authorization header (dev.to uses the dedicated `api-key`
 *     header). The key value never appears in the URL.
 *   - Error messages never echo the key or its length.
 *   - No automatic retry. No background poll.
 *
 * Pure function. No I/O outside the injected `fetchImpl`.
 */

const DEVTO_API_BASE = "https://dev.to/api";

/**
 * dev.to usernames: 2-30 chars, alphanumeric + underscores,
 * case-insensitive for matching. Loose validator to refuse
 * obviously-invalid input before paying the network round-trip.
 */
const DEVTO_USERNAME_RE = /^[a-z0-9_]{2,30}$/;

export interface DevtoVerifierInput {
  identityId: string;
  workspaceId: string;
  /** Identity's declared handle (growth_accounts.handle). */
  declaredHandle: string;
  /**
   * The dev.to API key. Used once, never stored/logged/returned by
   * this module. The route holds it in memory only for this call.
   */
  apiKey: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export type DevtoVerifierErrorCode =
  | "handle_invalid"
  | "credentials_missing"
  | "auth_failed"
  | "provider_error"
  | "network_error";

export interface DevtoVerifierConnected {
  outcome: "connected";
  providerAccountId: string; // dev.to numeric user.id (string-cast)
  authenticatedHandle: string; // canonical username (lowercased)
  /**
   * The plaintext API key, passed back so the route can encrypt +
   * persist. NEVER include this in any log, response body, or
   * stored metadata.
   */
  apiKey: string;
}

export interface DevtoVerifierMismatched {
  outcome: "mismatched";
  declaredHandle: string;
  authenticatedHandle: string;
  providerAccountId: string;
}

export interface DevtoVerifierError {
  outcome: "error";
  code: DevtoVerifierErrorCode;
  message: string;
}

export type DevtoVerifierResult =
  | DevtoVerifierConnected
  | DevtoVerifierMismatched
  | DevtoVerifierError;

/**
 * Lowercase + trim + strip a leading `@`. dev.to usernames are
 * case-insensitive, so this is enough to make declared and
 * authenticated handles comparable.
 */
export function normalizeDevtoUsername(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidDevtoUsername(username: string): boolean {
  return DEVTO_USERNAME_RE.test(username);
}

export async function verifyDevtoIdentity(
  input: DevtoVerifierInput,
): Promise<DevtoVerifierResult> {
  // ── Input validation ───────────────────────────────────────────
  const declared = normalizeDevtoUsername(input.declaredHandle);
  if (!declared) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message:
        "Identity has no declared dev.to username. Set the handle on the identity row before signing in.",
    };
  }
  if (!isValidDevtoUsername(declared)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: `Handle "${input.declaredHandle}" is not a valid dev.to username (2-30 chars, lowercase letters, digits, underscores).`,
    };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return {
      outcome: "error",
      code: "credentials_missing",
      message: "dev.to API key is required.",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  // ── GET /api/users/me ──────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    const res = await doFetch(`${DEVTO_API_BASE}/users/me`, {
      method: "GET",
      headers: {
        // dev.to's canonical auth header (lowercase, hyphenated).
        // The key NEVER appears in the URL — only in the header for
        // the duration of this single request.
        "api-key": input.apiKey,
        accept: "application/vnd.forem.api-v1+json",
      },
    });

    if (res.status === 401) {
      // Bad credentials. Do NOT echo the key or its length.
      return {
        outcome: "error",
        code: "auth_failed",
        message:
          "dev.to rejected the API key. Double-check the key on the dev.to settings page.",
      };
    }
    if (res.status === 404) {
      return {
        outcome: "error",
        code: "provider_error",
        message: "dev.to returned 404 for /api/users/me — endpoint may have moved.",
      };
    }
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `dev.to /api/users/me failed: HTTP ${res.status}.`,
      };
    }
    body = (await safeJson(res)) ?? {};
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching dev.to: ${(err as Error).message ?? "unknown"}.`,
    };
  }

  // ── Validate response shape ───────────────────────────────────
  const username =
    typeof body.username === "string" ? body.username : null;
  const id =
    typeof body.id === "number"
      ? String(body.id)
      : typeof body.id === "string"
        ? body.id
        : null;
  if (!username || !id) {
    return {
      outcome: "error",
      code: "provider_error",
      message:
        "dev.to /api/users/me returned an unexpected response shape (missing username or id).",
    };
  }

  // ── Username match check ──────────────────────────────────────
  const authenticatedNormalized = normalizeDevtoUsername(username);
  if (!authenticatedNormalized || authenticatedNormalized !== declared) {
    return {
      outcome: "mismatched",
      declaredHandle: input.declaredHandle,
      authenticatedHandle: username,
      providerAccountId: id,
    };
  }

  return {
    outcome: "connected",
    providerAccountId: id,
    authenticatedHandle: authenticatedNormalized,
    apiKey: input.apiKey,
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
