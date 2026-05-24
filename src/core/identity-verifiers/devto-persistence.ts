/**
 * Translates a dev.to verifier result into the upsert plan + HTTP
 * response shape the connect route should produce.
 *
 * Pure function. Encrypts the API key via the existing
 * `encryptTokenResponse` AES-256-GCM pipeline — the same cipher
 * OAuth and Bluesky use. Plaintext keys never reach the upsert plan.
 *
 * Safety properties (pinned by tests):
 *   - Plaintext API key is consumed inside this helper and emerges
 *     only as an encrypted envelope in `accessTokenEncrypted`. The
 *     HTTP response carries only the public username + id.
 *   - On mismatch, an audit row is written with
 *     connection_status='error' and metadata.handle_mismatch
 *     (same shape as Bluesky / Reddit OAuth). The encrypted column
 *     is NULL — we won't publish under the wrong account.
 *   - On encryption refusal (no TOKEN_ENCRYPTION_KEY), the plan
 *     refuses to persist and returns 503.
 *   - Error outcomes (auth_failed, missing key, etc.) write nothing.
 */

import { encryptTokenResponse } from "@/core/platform-oauth/token-storage";
import { getTokenCipher } from "@/core/platform-oauth/token-encryption";
import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type { DevtoVerifierResult } from "./devto";

export interface DevtoVerifyPlanInput {
  result: DevtoVerifierResult;
  workspaceId: string;
  identityId: string;
  declaredHandle: string | null;
}

export interface DevtoVerifyPlan {
  upsert: UpsertConnectionInput | null;
  promoteGrowthAccount: boolean;
  response: {
    status: number;
    body: Record<string, unknown>;
  };
}

const VERIFICATION_METHOD = "devto.users.me";

export function buildDevtoVerifyPlan(
  input: DevtoVerifyPlanInput,
): DevtoVerifyPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;

  if (result.outcome === "connected") {
    // Encrypt the API key. dev.to has no refresh token, no scopes,
    // no token expiry that the provider returns — the key is the
    // credential. Treat as access_token, refresh_token=null.
    const enc = encryptTokenResponse({
      platform: "devto",
      response: {
        accessToken: result.apiKey,
        refreshToken: null,
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
            platform: "devto",
            identity_id: identityId,
            message:
              "Server session encryption is not configured correctly. Ask an administrator to configure TOKEN_ENCRYPTION_KEY and redeploy.",
          },
        },
      };
    }

    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "devto",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.authenticatedHandle,
      scopes: [],
      accessTokenEncrypted: enc.accessTokenEncrypted,
      refreshTokenEncrypted: null,
      expiresAt: null,
      connectionStatus: "connected",
      metadata: {
        verification_method: VERIFICATION_METHOD,
        token_storage: getTokenCipher().describe(),
        last_message: `Signed in as ${result.authenticatedHandle}.`,
      },
    };
    return {
      upsert,
      promoteGrowthAccount: true,
      response: {
        status: 200,
        body: {
          ok: true,
          platform: "devto",
          identity_id: identityId,
          authenticated_handle: result.authenticatedHandle,
          provider_account_id: result.providerAccountId,
          // No API key, no encrypted blobs, no token-shaped fields.
        },
      },
    };
  }

  if (result.outcome === "mismatched") {
    const upsert: UpsertConnectionInput = {
      workspaceId,
      accountId: identityId,
      platform: "devto",
      providerAccountId: result.providerAccountId,
      handle: result.authenticatedHandle,
      displayName: result.authenticatedHandle,
      scopes: [],
      accessTokenEncrypted: null, // refuse to persist key on mismatch
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
          platform: "devto",
          identity_id: identityId,
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          message:
            "The API key belongs to a different dev.to account. Use the API key for the account this identity represents.",
        },
      },
    };
  }

  // result.outcome === "error" — no row written.
  const httpStatus =
    result.code === "auth_failed"
      ? 401
      : result.code === "handle_invalid" ||
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
        platform: "devto",
        identity_id: identityId,
        declared: declaredHandle,
        message: result.message,
      },
    },
  };
}
