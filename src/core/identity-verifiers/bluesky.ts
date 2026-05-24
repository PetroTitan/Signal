/**
 * Bluesky identity verifier.
 *
 * Resolves a declared Bluesky handle to its DID through the AT
 * Protocol's public identity resolution + profile endpoints, then
 * verifies the DID's canonical handle matches the operator's
 * declared handle (defense against handles that have been re-pointed
 * to a different DID since the operator declared the identity).
 *
 * Endpoints used:
 *   - com.atproto.identity.resolveHandle   → declared handle → DID
 *   - app.bsky.actor.getProfile            → DID → canonical handle
 *
 * Both are public (no app password, no OAuth, no auth headers). This
 * means the verifier proves the handle EXISTS and is currently
 * resolvable, not that the workspace operator OWNS it. Posting
 * (which does require BLUESKY_APP_PASSWORD) is the de-facto ownership
 * test and runs through the existing publish-bluesky path; this
 * verifier only sets up the per-identity binding so that path knows
 * which DID belongs to which identity.
 *
 * Pure function. No I/O happens outside the injected `fetchImpl`,
 * which defaults to global fetch in production and is replaced by a
 * mock in tests.
 *
 * No secrets accepted, none stored, none returned.
 */

const BLUESKY_PUBLIC_API = "https://public.api.bsky.app";

/**
 * Bluesky handle format. Domain-style: 2+ DNS-style labels joined by
 * dots. ASCII lowercase, digits, hyphens (not at start/end). At
 * least one dot. Mirrors the AT Protocol handle spec (loose, not
 * strict — Bluesky itself accepts anything that resolves).
 *
 * Used to refuse obviously-invalid input early instead of paying the
 * network round-trip for "foo" or "@@@".
 */
const HANDLE_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export interface BlueskyVerifierInput {
  identityId: string;
  workspaceId: string;
  declaredHandle: string;
  /**
   * Optional fetch implementation. Defaults to global fetch in
   * production; tests inject a mock. Same shape as window.fetch.
   */
  fetchImpl?: typeof fetch;
}

export type BlueskyVerifierErrorCode =
  | "handle_invalid"
  | "handle_not_found"
  | "provider_error"
  | "network_error";

export interface BlueskyVerifierVerified {
  outcome: "verified";
  providerAccountId: string; // DID
  authenticatedHandle: string; // canonical, normalized
}

export interface BlueskyVerifierMismatched {
  outcome: "mismatched";
  declaredHandle: string; // original input (pre-normalization)
  authenticatedHandle: string; // canonical handle from AT Proto
  providerAccountId: string | null;
}

export interface BlueskyVerifierError {
  outcome: "error";
  code: BlueskyVerifierErrorCode;
  message: string;
}

export type BlueskyVerifierResult =
  | BlueskyVerifierVerified
  | BlueskyVerifierMismatched
  | BlueskyVerifierError;

/**
 * Strip Bluesky display prefix (`@`), lowercase, trim. Returns null
 * for empty input. The AT Protocol API expects bare-domain handles
 * (no leading `@`); the operator UI may carry `@` as visual sugar.
 */
export function normalizeBlueskyHandle(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidBlueskyHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

export async function verifyBlueskyIdentity(
  input: BlueskyVerifierInput,
): Promise<BlueskyVerifierResult> {
  const normalized = normalizeBlueskyHandle(input.declaredHandle);
  if (!normalized) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: "Identity has no declared Bluesky handle to verify.",
    };
  }
  if (!isValidBlueskyHandle(normalized)) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: `Handle "${input.declaredHandle}" is not a valid Bluesky handle (expected domain form, e.g. "name.bsky.social").`,
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  // Step 1 — resolve handle to DID.
  let did: string;
  try {
    const url = `${BLUESKY_PUBLIC_API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`;
    const res = await doFetch(url);
    if (res.status === 400) {
      // AT Proto returns 400 + { error: "HandleNotFound" | "InvalidHandle" }
      const body = (await safeJson(res)) ?? {};
      const code = typeof body.error === "string" ? body.error : null;
      if (code === "HandleNotFound" || code === "InvalidHandle") {
        return {
          outcome: "error",
          code: "handle_not_found",
          message: `Bluesky reports "${normalized}" is not a current handle (${code}).`,
        };
      }
      return {
        outcome: "error",
        code: "provider_error",
        message: `Bluesky resolveHandle returned 400${code ? ` (${code})` : ""}.`,
      };
    }
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Bluesky resolveHandle failed: HTTP ${res.status}.`,
      };
    }
    const body = (await safeJson(res)) ?? {};
    if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
      return {
        outcome: "error",
        code: "provider_error",
        message: "Bluesky resolveHandle returned a response without a DID.",
      };
    }
    did = body.did;
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Bluesky resolveHandle: ${(err as Error).message ?? "unknown"}.`,
    };
  }

  // Step 2 — fetch the DID's canonical handle and verify it matches.
  let canonicalHandle: string;
  try {
    const url = `${BLUESKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`;
    const res = await doFetch(url);
    if (!res.ok) {
      return {
        outcome: "error",
        code: "provider_error",
        message: `Bluesky getProfile failed: HTTP ${res.status}.`,
      };
    }
    const body = (await safeJson(res)) ?? {};
    if (typeof body.handle !== "string" || body.handle.length === 0) {
      return {
        outcome: "error",
        code: "provider_error",
        message: "Bluesky getProfile returned no handle field.",
      };
    }
    canonicalHandle = body.handle;
  } catch (err) {
    return {
      outcome: "error",
      code: "network_error",
      message: `Network error reaching Bluesky getProfile: ${(err as Error).message ?? "unknown"}.`,
    };
  }

  const canonicalNormalized = normalizeBlueskyHandle(canonicalHandle);
  if (!canonicalNormalized || canonicalNormalized !== normalized) {
    return {
      outcome: "mismatched",
      declaredHandle: input.declaredHandle,
      authenticatedHandle: canonicalHandle,
      providerAccountId: did,
    };
  }

  return {
    outcome: "verified",
    providerAccountId: did,
    authenticatedHandle: canonicalNormalized,
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
