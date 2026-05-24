/**
 * Hashnode identity verifier.
 *
 * Ownership-proving flow for Hashnode identities. Each identity has
 * its own Hashnode API key (one key = one account). The verifier
 * sends the GraphQL query `me { username id }` to Hashnode's
 * gateway, confirms the returned username matches the identity's
 * declared handle, then hands the key back to the route to encrypt
 * and persist.
 *
 * Endpoint:
 *   POST https://gql.hashnode.com
 *   headers: { Authorization: "<key>", Content-Type: "application/json" }
 *   body:   { query: "{ me { username id } }" }
 *
 * Hashnode's auth header carries the key verbatim — no Bearer
 * prefix. GraphQL endpoints typically return HTTP 200 even for
 * auth failures and put the error under `errors[]`, so the
 * verifier checks both the HTTP status AND the GraphQL `errors`
 * payload.
 *
 * Security posture:
 *   - The API key is taken as input, used once, never returned by
 *     this module beyond the `connected` outcome's apiKey field
 *     (which the route consumes immediately to encrypt + discard).
 *   - The key NEVER appears in the URL or in any error message.
 *   - No Authorization echo, no key in serialized errors.
 *
 * Pure function. No I/O outside the injected `fetchImpl`.
 */

const HASHNODE_GQL_ENDPOINT = "https://gql.hashnode.com";

/**
 * Hashnode username: 2-40 chars, lowercase letters, digits,
 * hyphens, underscores. Case-insensitive for matching.
 */
const HASHNODE_USERNAME_RE = /^[a-z0-9_-]{2,40}$/;

const ME_QUERY = "query { me { username id } }";

export interface HashnodeVerifierInput {
  identityId: string;
  workspaceId: string;
  /** Identity's declared handle (growth_accounts.handle). */
  declaredHandle: string;
  /**
   * The Hashnode API key (Personal Access Token). Used once, never
   * stored or logged by this module.
   */
  apiKey: string;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

export type HashnodeVerifierErrorCode =
  | "handle_invalid"
  | "credentials_missing"
  | "auth_failed"
  | "provider_error"
  | "network_error";

export interface HashnodeVerifierConnected {
  outcome: "connected";
  providerAccountId: string;
  authenticatedHandle: string;
  /** Plaintext API key — route consumes once to encrypt + discard. */
  apiKey: string;
}

export interface HashnodeVerifierMismatched {
  outcome: "mismatched";
  declaredHandle: string;
  authenticatedHandle: string;
  providerAccountId: string;
}

export interface HashnodeVerifierError {
  outcome: "error";
  code: HashnodeVerifierErrorCode;
  message: string;
}

export type HashnodeVerifierResult =
  | HashnodeVerifierConnected
  | HashnodeVerifierMismatched
  | HashnodeVerifierError;

export function normalizeHashnodeUsername(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidHashnodeUsername(username: string): boolean {
  return HASHNODE_USERNAME_RE.test(username);
}

export async function verifyHashnodeIdentity(
  input: HashnodeVerifierInput,
): Promise<HashnodeVerifierResult> {
  // ── Input validation ───────────────────────────────────────────
  const declared = normalizeHashnodeUsername(input.declaredHandle);
  if (!declared) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message:
        "Identity has no declared Hashnode username. Set the handle on the identity row before signing in.",
    };
  }
  if (!isValidHashnodeUsername(declared)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: `Handle "${input.declaredHandle}" is not a valid Hashnode username (2-40 chars, lowercase letters, digits, hyphens, underscores).`,
    };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return {
      outcome: "error",
      code: "credentials_missing",
      message: "Hashnode API key is required.",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  // ── POST the GraphQL query ─────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    const res = await doFetch(HASHNODE_GQL_ENDPOINT, {
      method: "POST",
      headers: {
        // Hashnode uses the bare key as Authorization (no Bearer).
        // The key NEVER appears in the URL.
        Authorization: input.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: ME_QUERY }),
    });

    if (res.status === 401 || res.status === 403) {
      // Hashnode returns 401/403 for malformed auth headers; the
      // GraphQL-level auth error usually comes back as a 200 with
      // an `errors[]` entry, handled below.
      return {
        outcome: "error",
        code: "auth_failed",
        message:
          "Hashnode rejected the API key. Double-check the key on the Hashnode developer settings page.",
      };
    }
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Hashnode GraphQL failed: HTTP ${res.status}.`,
      };
    }
    body = (await safeJson(res)) ?? {};
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Hashnode: ${(err as Error).message ?? "unknown"}.`,
    };
  }

  // ── GraphQL-level error envelope ───────────────────────────────
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    // Treat any UNAUTHENTICATED/FORBIDDEN/Token-related error as
    // auth_failed; everything else as provider_error. Look at the
    // extensions.code first, fall back to a substring scan of the
    // message — never echo Hashnode's message verbatim because we
    // don't trust it to be secret-free (the GraphQL spec doesn't
    // forbid headers being echoed in error contexts).
    const first = errors[0] as Record<string, unknown>;
    const ext = (first?.extensions ?? {}) as Record<string, unknown>;
    const code = typeof ext.code === "string" ? ext.code : "";
    const message =
      typeof first?.message === "string" ? first.message : "";
    const looksAuth =
      code === "UNAUTHENTICATED" ||
      code === "FORBIDDEN" ||
      /auth|token|unauthor/i.test(message);
    if (looksAuth) {
      return {
        outcome: "error",
        code: "auth_failed",
        message:
          "Hashnode rejected the API key. Double-check the key on the Hashnode developer settings page.",
      };
    }
    return {
      outcome: "error",
      code: "provider_error",
      message: `Hashnode GraphQL returned an error (${code || "unknown"}).`,
    };
  }

  // ── Validate response shape ───────────────────────────────────
  const data = body.data as Record<string, unknown> | undefined;
  const me = data?.me as Record<string, unknown> | undefined;
  const username =
    typeof me?.username === "string" ? me.username : null;
  const id = typeof me?.id === "string" ? me.id : null;
  if (!username || !id) {
    return {
      outcome: "error",
      code: "provider_error",
      message:
        "Hashnode GraphQL returned an unexpected response shape (missing me.username or me.id).",
    };
  }

  // ── Username match check ──────────────────────────────────────
  const authenticatedNormalized = normalizeHashnodeUsername(username);
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
