/**
 * Translates a Bluesky app-password session result into the upsert
 * plan + HTTP response the connect route should produce.
 *
 * Pure function. The actual token encryption is delegated to
 * `encryptTokenResponse` so the same crypto path OAuth uses applies
 * here too — same key, same algorithm, same refusal semantics.
 *
 * Critical safety properties:
 *   - Plaintext JWTs are passed IN and turned into encrypted blobs
 *     before they reach the upsert plan. The plan never carries
 *     plaintext.
 *   - The HTTP response NEVER includes the JWTs or the app password.
 *   - metadata stores only diagnostic info: verification_method,
 *     last_message, optional handle_mismatch payload — no tokens,
 *     no password, no Authorization headers.
 *   - On encryption failure (cipher not configured / refused) the
 *     plan declines to persist anything; the route returns a clean
 *     error to the operator.
 *   - On mismatch the plan still records the connection row with
 *     connection_status='error' and handle_mismatch metadata, but
 *     DOES NOT persist the encrypted tokens — we won't publish
 *     under the wrong account.
 */

import { encryptTokenResponse } from "@/core/platform-oauth/token-storage";
import { getTokenCipher } from "@/core/platform-oauth/token-encryption";
import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type { BlueskySessionResult } from "./bluesky-session";

export interface BlueskySessionPlanInput {
  result: BlueskySessionResult;
  workspaceId: string;
  identityId: string;
  declaredHandle: string | null;
}

export interface BlueskySessionPlan {
  /** Connection row to upsert. Null on pure error paths. */
  upsert: UpsertConnectionInput | null;
  /**
   * Whether to set growth_accounts.connection_status = "connected"
   * for the identity. Only true on the connected outcome.
   */
  promoteGrowthAccount: boolean;
  /** HTTP response shape the route should return. */
  response: {
    status: number;
    body: Record<string, unknown>;
  };
}

const VERIFICATION_METHOD = "atproto.server.createSession";

export function buildBlueskySessionPlan(
  input: BlueskySessionPlanInput,
): BlueskySessionPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;

  if (result.outcome === "connected") {
    // Encrypt JWTs before they reach the upsert plan. If the cipher
    // refuses (no TOKEN_ENCRYPTION_KEY), we MUST NOT persist
    // plaintext tokens and we MUST NOT mark connected.
    const enc = encryptTokenResponse({
      platform: "bluesky",
      response: {
        accessToken: result.accessJwt,
        refreshToken: result.refreshJwt,
        // AT Protocol session JWTs are short-lived (~2 hours for
        // access, longer for refresh) but the API doesn't return an
        // explicit expires_in. We leave expiresAt null; the
        // publishing path refreshes when a call returns 401.
        expiresInSeconds: null,
        scopes: [],
      },
    });
    if (!enc.ok) {
      return {
        upsert: null,
        promoteGrowthAccount: false,
        response: {
          status: 503,
          body: {
            ok: false,
            code: "token_storage_unavailable",
            platform: "bluesky",
            identity_id: identityId,
            // Operator-facing copy: name the configuration symptom,
            // steer to the fix, never reference key VALUES, never
            // include stack traces. Internal diagnostic detail
            // (env-var name, etc.) is the only platform-specific
            // hint operators need to find the env var dashboard.
            message:
              "Server session encryption is not configured correctly. Ask an administrator to configure TOKEN_ENCRYPTION_KEY and redeploy.",
          },
        },
      };
    }

    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "bluesky",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.authenticatedHandle,
      scopes: [],
      accessTokenEncrypted: enc.accessTokenEncrypted,
      refreshTokenEncrypted: enc.refreshTokenEncrypted,
      expiresAt: enc.expiresAt,
      connectionStatus: "connected",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        token_storage: getTokenCipher().describe(),
        last_message: `Connected as ${result.authenticatedHandle}.`,
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
          // DELIBERATELY no JWT fields in the response.
        },
      },
    };
  }

  if (result.outcome === "mismatched") {
    // Authentication succeeded but the DID doesn't match the
    // declared identity. Record the audit trail; do NOT persist
    // tokens (we won't publish under the wrong account).
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
        last_message: `Authenticated as ${result.authenticatedHandle}, but identity expected ${result.declaredHandle}.`,
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
          message:
            "The credentials belong to a different Bluesky account. Reconnect with the App Password for the correct account.",
        },
      },
    };
  }

  // result.outcome === "error" — no row written.
  const httpStatus =
    result.code === "auth_failed"
      ? 401
      : result.code === "handle_invalid" ||
          result.code === "identifier_invalid" ||
          result.code === "credentials_missing"
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
