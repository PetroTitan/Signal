/**
 * OAuth callback handle verification.
 *
 * The original Reddit callback marked a connection `connected` as
 * long as token exchange + /me succeeded. It never checked that the
 * authenticated Reddit username matched the identity the operator
 * clicked Connect on. If the operator clicked Connect on the
 * u/Webmasterid-core identity card and logged in with a different
 * Reddit account, the connection landed bound to the wrong account.
 *
 * This helper closes that gap. Pure function, no I/O — the callback
 * route fetches the declared handle from growth_accounts and the
 * authenticated handle from the provider /me response, then asks
 * verifyIdentityHandle() what to do.
 *
 * Three outcomes:
 *
 *   - "match"          — declared and authenticated handles agree;
 *                        proceed with the existing happy path.
 *   - "indeterminate"  — one side is missing (e.g. the identity row
 *                        carries no declared handle yet, or the
 *                        provider returned an unnamed account).
 *                        Treated as match for the purpose of marking
 *                        connected — we have no claim to refuse.
 *   - "mismatch"       — handles disagree; the callback MUST refuse
 *                        to mark the identity connected. Connection
 *                        row is still upserted (audit trail) but
 *                        with connectionStatus="error" and a
 *                        metadata.handle_mismatch payload so the UI
 *                        can render expected-vs-authenticated.
 *
 * The helper does NOT decide what to persist or what error code to
 * surface — those concerns live in the route. The helper only
 * answers: "given these two handles, are they the same identity?"
 */

import { compareHandles } from "@/core/publishing/identity-publish-state";

export type HandleVerifyOutcome = "match" | "indeterminate" | "mismatch";

export interface HandleVerifyInput {
  /**
   * The handle the operator declared on the identity row
   * (growth_accounts.handle). May be null/undefined when the
   * identity has no declared handle yet — in that case the
   * verification is "indeterminate" and the caller should fall
   * through to the existing happy path.
   */
  declaredHandle: string | null | undefined;
  /**
   * The handle the OAuth provider returned for the authenticated
   * token (e.g. Reddit /me's `name`). May be null/undefined when the
   * provider didn't surface a handle.
   */
  authenticatedHandle: string | null | undefined;
}

export interface HandleVerifyResult {
  outcome: HandleVerifyOutcome;
  /** Original (un-normalized) declared handle, for UI rendering. */
  declaredHandle: string | null;
  /** Original (un-normalized) authenticated handle, for UI rendering. */
  authenticatedHandle: string | null;
}

export function verifyIdentityHandle(
  input: HandleVerifyInput,
): HandleVerifyResult {
  const declared = normalizeForResult(input.declaredHandle);
  const authenticated = normalizeForResult(input.authenticatedHandle);
  const cmp = compareHandles(declared, authenticated);
  return {
    outcome:
      cmp === "match" ? "match" : cmp === "mismatch" ? "mismatch" : "indeterminate",
    declaredHandle: declared,
    authenticatedHandle: authenticated,
  };
}

function normalizeForResult(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Format the handle-mismatch metadata payload stored on
 * `platform_connections.metadata.handle_mismatch`. Stable shape so
 * the UI and the resolver can both read it without guessing.
 */
export interface HandleMismatchMetadata {
  declared: string | null;
  authenticated: string | null;
  /** ISO timestamp when this mismatch was last observed. */
  observedAt: string;
}

export function buildHandleMismatchMetadata(result: HandleVerifyResult): HandleMismatchMetadata {
  return {
    declared: result.declaredHandle,
    authenticated: result.authenticatedHandle,
    observedAt: new Date().toISOString(),
  };
}
