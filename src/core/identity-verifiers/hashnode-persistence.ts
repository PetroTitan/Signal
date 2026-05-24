/**
 * Translates a Hashnode verifier result into the upsert plan + HTTP
 * response shape the connect route should produce.
 *
 * Same shape and safety properties as the dev.to persistence
 * helper (encrypted key in `access_token_encrypted`, handle_mismatch
 * metadata on mismatch, never-the-key in any returned surface).
 * Hashnode also has no refresh token semantics — the API key is the
 * credential.
 */

import { encryptTokenResponse } from "@/core/platform-oauth/token-storage";
import { getTokenCipher } from "@/core/platform-oauth/token-encryption";
import type { UpsertConnectionInput } from "@/repositories/platform-connection-repository";
import type { HashnodeVerifierResult } from "./hashnode";

export interface HashnodeVerifyPlanInput {
  result: HashnodeVerifierResult;
  workspaceId: string;
  identityId: string;
  declaredHandle: string | null;
}

export interface HashnodeVerifyPlan {
  upsert: UpsertConnectionInput | null;
  promoteGrowthAccount: boolean;
  response: {
    status: number;
    body: Record<string, unknown>;
  };
}

const VERIFICATION_METHOD = "hashnode.graphql.me";

export function buildHashnodeVerifyPlan(
  input: HashnodeVerifyPlanInput,
): HashnodeVerifyPlan {
  const { result, workspaceId, identityId, declaredHandle } = input;

  if (result.outcome === "connected") {
    const enc = encryptTokenResponse({
      platform: "hashnode",
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
            platform: "hashnode",
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
      platform: "hashnode",
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
          platform: "hashnode",
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
      platform: "hashnode",
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
          platform: "hashnode",
          identity_id: identityId,
          declared: result.declaredHandle,
          authenticated: result.authenticatedHandle,
          message:
            "The API key belongs to a different Hashnode account. Use the API key for the account this identity represents.",
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
        platform: "hashnode",
        identity_id: identityId,
        declared: declaredHandle,
        message: result.message,
      },
    },
  };
}
