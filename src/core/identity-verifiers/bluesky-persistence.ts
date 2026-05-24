/**
 * Translates a Bluesky verifier result into the upsert shape +
 * HTTP response the route should produce.
 *
 * Kept as a pure function so the route stays thin (just I/O) and the
 * persistence contract is unit-testable without a real Supabase
 * client. The route invokes this, then calls
 * upsertPlatformConnection + setAccountConnectionStatus with the
 * returned plan.
 *
 * Critical security properties enforced here:
 *   - No tokens, app passwords, or API keys ever appear in the
 *     upsert metadata. The Bluesky verifier doesn't take any
 *     secrets in the first place (AT Protocol resolveHandle +
 *     getProfile are public endpoints), so the only thing to persist
 *     is the resolved DID + canonical handle.
 *   - Mismatch lands as connection_status='error' with
 *     metadata.handle_mismatch — the same shape the OAuth callback
 *     uses, so the identity-publish-state resolver surfaces
 *     'mismatched' via the existing handleMismatchObserved path.
 *   - Error paths do NOT write a connection row.
 *   - growth_accounts.connection_status is promoted to 'connected'
 *     only on verified outcome.
 */

import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type { BlueskyVerifierResult } from "./bluesky";

export interface BlueskyVerifyPlanInput {
  result: BlueskyVerifierResult;
  workspaceId: string;
  identityId: string;
  /** The identity's declared handle (growth_accounts.handle). */
  declaredHandle: string | null;
}

export interface BlueskyVerifyPlan {
  /** Connection row to upsert. Null on pure error paths. */
  upsert: UpsertConnectionInput | null;
  /**
   * Whether to set growth_accounts.connection_status = "connected"
   * for the identity. Only true on the verified outcome.
   */
  promoteGrowthAccount: boolean;
  /** HTTP response shape the route should return. */
  response: {
    status: number;
    body: Record<string, unknown>;
  };
}

const VERIFICATION_METHOD = "atproto.identity.resolveHandle+getProfile";

export function buildBlueskyVerifyPlan(
  input: BlueskyVerifyPlanInput,
): BlueskyVerifyPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;

  if (result.outcome === "verified") {
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "bluesky",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.authenticatedHandle,
      scopes: [],
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "connected",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        last_message: `Verified as ${result.authenticatedHandle}.`,
      },
    };
    return {
      upsert,
      promoteGrowthAccount: true,
      response: {
        status: 200,
        body: {
          ok: true,
          platform: "bluesky",
          identity_id: identityId,
          authenticated_handle: result.authenticatedHandle,
          provider_account_id: result.providerAccountId,
        },
      },
    };
  }

  if (result.outcome === "mismatched") {
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "bluesky",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.authenticatedHandle,
      scopes: [],
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "error",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        last_message: `Declared ${result.declaredHandle} resolves to a different canonical handle: ${result.authenticatedHandle}.`,
        handle_mismatch: {
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          observedAt: new Date().toISOString(),
        },
      },
    };
    return {
      upsert,
      promoteGrowthAccount: false,
      response: {
        status: 409,
        body: {
          ok: false,
          code: "handle_mismatch",
          platform: "bluesky",
          identity_id: identityId,
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          message: `The handle resolves to a different account on Bluesky. Reconnect with the correct handle.`,
        },
      },
    };
  }

  // result.outcome === "error" — do NOT write a connection row.
  // Different HTTP statuses per error code so the UI can decide
  // whether to retry vs ask the operator to fix the handle.
  const httpStatus =
    result.code === "handle_invalid" || result.code === "handle_not_found"
      ? 400
      : result.code === "network_error"
        ? 503
        : 502;
  return {
    upsert: null,
    promoteGrowthAccount: false,
    response: {
      status: httpStatus,
      body: {
        ok: false,
        code: result.code,
        platform: "bluesky",
        identity_id: identityId,
        declared: declaredHandle,
        message: result.message,
      },
    },
  };
}
