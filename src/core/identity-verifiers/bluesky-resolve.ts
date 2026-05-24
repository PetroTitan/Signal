/**
 * Bluesky public handle resolution.
 *
 * NOT an identity verifier in the publishing-ownership sense. This
 * module resolves a declared Bluesky handle to its DID through the
 * AT Protocol's PUBLIC endpoints, and checks that the DID's
 * canonical handle still matches the declared handle.
 *
 * What this PROVES:
 *   - The handle currently exists on the AT Protocol network
 *   - It resolves to a specific DID
 *   - That DID's canonical handle has not drifted away from the
 *     declared value
 *
 * What this does NOT prove:
 *   - That the workspace operator OWNS the handle. Anyone can
 *     resolve anyone's handle.
 *   - That Signal can publish AS that handle. Publishing requires a
 *     Bluesky App Password and a server-side authenticated session;
 *     that is the job of `bluesky-session.ts`.
 *
 * Endpoints used (all public, no auth headers):
 *   - com.atproto.identity.resolveHandle   → declared handle → DID
 *   - app.bsky.actor.getProfile            → DID → canonical handle
 *
 * Result is informational only. The route that calls this does NOT
 * write a platform_connections row from the result. Connection rows
 * are written exclusively by the app-password session flow.
 *
 * Pure function. No I/O outside the injected `fetchImpl`, which
 * defaults to global fetch in production and is replaced by a mock
 * in tests.
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

export interface BlueskyResolveInput {
  identityId: string;
  workspaceId: string;
  declaredHandle: string;
  /**
   * Optional fetch implementation. Defaults to global fetch in
   * production; tests inject a mock. Same shape as window.fetch.
   */
  fetchImpl?: typeof fetch;
}

export type BlueskyResolveErrorCode =
  | "handle_invalid"
  | "handle_not_found"
  | "provider_error"
  | "network_error";

/**
 * The handle resolved cleanly and its canonical form still matches
 * the declared value. The route should NOT mark the identity as
 * connected based on this outcome — connection requires the
 * separate app-password session flow.
 */
export interface BlueskyHandleResolved {
  outcome: "handle_resolved";
  providerAccountId: string; // DID
  /** Canonical handle, normalized. */
  authenticatedHandle: string;
}

/**
 * The handle resolved to a DID whose canonical handle is different.
 * Informational; the route does not persist this either — but the
 * operator should be told the declared handle has drifted, because
 * the app-password connect step would also surface it.
 */
export interface BlueskyHandleMismatched {
  outcome: "mismatched";
  declaredHandle: string;
  authenticatedHandle: string;
  providerAccountId: string | null;
}

export interface BlueskyResolveError {
  outcome: "error";
  code: BlueskyResolveErrorCode;
  message: string;
}

export type BlueskyResolveResult =
  | BlueskyHandleResolved
  | BlueskyHandleMismatched
  | BlueskyResolveError;

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

export async function resolveBlueskyHandle(
  input: BlueskyResolveInput,
): Promise<BlueskyResolveResult> {
  const normalized = normalizeBlueskyHandle(input.declaredHandle);
  if (!normalized) {
    return {
      outcome: "error",
      code: "handle_invalid",
      message: "Identity has no declared Bluesky handle to resolve.",
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

  // Step 2 — fetch the DID's canonical handle and check it matches.
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
    outcome: "handle_resolved",
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
