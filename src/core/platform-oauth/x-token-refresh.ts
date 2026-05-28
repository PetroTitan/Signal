/**
 * X-scoped OAuth token refresh.
 *
 * Wraps the X OAuth 2.0 refresh flow (rotation-required) with the
 * persistence + reauth-required signaling the scheduler needs to
 * decide whether to publish, skip, or block.
 *
 * Hard rules
 * ----------
 *   - Plaintext refresh + access tokens live for ONE call frame at a
 *     time. Never returned in the outcome object.
 *   - Failures with code `invalid_grant` (refresh revoked) MUST move
 *     the connection to `connection_status='reauthorization_required'`
 *     and clear the encrypted blobs. The next publish attempt sees a
 *     clear `oauth_reauthorization_required` reason; no silent retry.
 *   - Transient errors (network, 5xx) return `transient_error` so the
 *     scheduler can `publishSkip` and try again next tick.
 *   - X rotates refresh tokens — the new `refresh_token` from the
 *     response is persisted; the old one is invalidated by the server.
 *
 * Pure-ish module: I/O is limited to the X token endpoint and a
 * single UPDATE on `platform_connections`. No other side effects.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readOAuthProviderRuntime } from "@/lib/oauth/env";
import { getTokenCipher } from "./token-encryption";
import { refreshXAccessToken } from "./x-client";

export type XEnsureTokenOutcome =
  | { kind: "no_refresh_needed" }
  | { kind: "refreshed" }
  | { kind: "reauthorization_required"; reason: string }
  | { kind: "transient_error"; reason: string };

export interface XEnsureTokenResult {
  outcome: XEnsureTokenOutcome;
  /**
   * Encrypted access token to use for THIS publish attempt. May be
   * the input value (no refresh needed) or the freshly-rotated value
   * (after a successful refresh). Null when the refresh failed in a
   * way that invalidated the token (reauth required).
   */
  accessTokenEncrypted: string | null;
}

export interface EnsureFreshXAccessTokenInput {
  /** Supabase client (service-role for the scheduler tick). */
  db: SupabaseClient;
  workspaceId: string;
  /** `platform_connections.id`. */
  connectionId: string;
  currentAccessTokenEncrypted: string | null;
  currentRefreshTokenEncrypted: string | null;
  /** `platform_connections.expires_at` (ISO timestamptz). */
  currentExpiresAt: string | null;
  /** Wall-clock now (the scheduler threads this through). */
  nowIso: string;
  /** Refresh when remaining ≤ buffer seconds. Default 60. */
  refreshBufferSeconds?: number;
}

const DEFAULT_REFRESH_BUFFER_SECONDS = 60;

export async function ensureFreshXAccessToken(
  input: EnsureFreshXAccessTokenInput,
): Promise<XEnsureTokenResult> {
  const buffer = input.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS;

  // Nothing to refresh against — surface the original token unchanged.
  // The scheduler's policy gate will still reject the publish if the
  // access token is missing, via the existing `oauth_token_not_stored`
  // check.
  if (!input.currentRefreshTokenEncrypted) {
    return {
      outcome: { kind: "no_refresh_needed" },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }

  // No expiry recorded → assume the token is valid. We refresh
  // proactively ONLY when we know expiry is close; preemptive
  // refreshes on every tick would burn quota on healthy tokens.
  if (!input.currentExpiresAt) {
    return {
      outcome: { kind: "no_refresh_needed" },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }

  const remainingMs =
    new Date(input.currentExpiresAt).getTime() -
    new Date(input.nowIso).getTime();
  if (!Number.isFinite(remainingMs) || remainingMs > buffer * 1000) {
    return {
      outcome: { kind: "no_refresh_needed" },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }

  // Need to refresh. Resolve runtime + cipher.
  const runtime = readOAuthProviderRuntime("x");
  if (!runtime) {
    return {
      outcome: {
        kind: "transient_error",
        reason: "X OAuth runtime is not configured (env missing).",
      },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }
  const cipher = getTokenCipher();
  if (!cipher.isAvailable()) {
    return {
      outcome: {
        kind: "transient_error",
        reason: "Token cipher unavailable; cannot decrypt refresh token.",
      },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }
  const refreshPlain = cipher.decrypt(input.currentRefreshTokenEncrypted);
  if (!refreshPlain) {
    return {
      outcome: {
        kind: "transient_error",
        reason: "Refresh token decrypt returned null.",
      },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }

  // Call X. Plaintext refresh token is held only for this call.
  const refreshResult = await refreshXAccessToken({
    runtime,
    refreshToken: refreshPlain,
  });

  if (!refreshResult.ok) {
    // invalid_grant or 401 → refresh was revoked. Mark the connection
    // reauth-required and clear the encrypted blobs so future ticks
    // can't reuse a known-bad token.
    const isReauth =
      refreshResult.code === "invalid_grant" ||
      refreshResult.code === "oauth_expired";
    if (isReauth) {
      await persistReauthRequired({
        db: input.db,
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        reason: refreshResult.code,
        nowIso: input.nowIso,
      });
      return {
        outcome: {
          kind: "reauthorization_required",
          reason: refreshResult.code,
        },
        accessTokenEncrypted: null,
      };
    }
    // network / 5xx / rate_limited / decode_error → transient.
    return {
      outcome: {
        kind: "transient_error",
        reason: refreshResult.code,
      },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }

  // Success — encrypt rotated tokens and persist.
  const newAccessEncrypted = cipher.encrypt(refreshResult.data.access_token);
  if (!newAccessEncrypted) {
    return {
      outcome: {
        kind: "transient_error",
        reason: "Re-encryption of the new access token failed.",
      },
      accessTokenEncrypted: input.currentAccessTokenEncrypted,
    };
  }
  const newRefreshEncrypted = refreshResult.data.refresh_token
    ? cipher.encrypt(refreshResult.data.refresh_token)
    : null;
  const newExpiresAt = new Date(
    new Date(input.nowIso).getTime() +
      refreshResult.data.expires_in * 1000,
  ).toISOString();

  await persistRotatedTokens({
    db: input.db,
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    accessTokenEncrypted: newAccessEncrypted,
    // Persist a rotated refresh token if the response carried one. X
    // SHOULD always return a new refresh_token, but if it doesn't (or
    // it's identical), leave the existing encrypted refresh blob
    // unchanged. We never write `null` here unless reauth is required.
    refreshTokenEncrypted: newRefreshEncrypted,
    expiresAt: newExpiresAt,
    nowIso: input.nowIso,
  });

  return {
    outcome: { kind: "refreshed" },
    accessTokenEncrypted: newAccessEncrypted,
  };
}

async function persistRotatedTokens(input: {
  db: SupabaseClient;
  workspaceId: string;
  connectionId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: string;
  nowIso: string;
}): Promise<void> {
  // Build the update payload. We only overwrite `refresh_token_encrypted`
  // when the server returned a new one; this avoids accidentally
  // wiping a valid blob when the response shape is partial.
  const patch: Record<string, unknown> = {
    access_token_encrypted: input.accessTokenEncrypted,
    expires_at: input.expiresAt,
    last_checked_at: input.nowIso,
    connection_status: "connected",
    health_status: "healthy",
  };
  if (input.refreshTokenEncrypted) {
    patch.refresh_token_encrypted = input.refreshTokenEncrypted;
  }
  // Best-effort: persistence failures bubble up so the scheduler can
  // log the issue, but the caller already has the new encrypted blob
  // in memory and can use it for the current publish attempt.
  const { error } = await input.db
    .from("platform_connections")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.connectionId);
  if (error) {
    // Surface via console only — never throw secrets. The plaintext
    // tokens are already out of scope by this point.
    console.error(
      "[x-token-refresh] failed to persist rotated tokens",
      error.message,
    );
  }
}

async function persistReauthRequired(input: {
  db: SupabaseClient;
  workspaceId: string;
  connectionId: string;
  reason: string;
  nowIso: string;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    connection_status: "reauthorization_required",
    access_token_encrypted: null,
    refresh_token_encrypted: null,
    last_checked_at: input.nowIso,
    metadata: {
      last_message: `X refresh failed: ${input.reason}. Operator must reconnect.`,
      reauth_required_reason: input.reason,
      reauth_required_at: input.nowIso,
    },
  };
  const { error } = await input.db
    .from("platform_connections")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.connectionId);
  if (error) {
    console.error(
      "[x-token-refresh] failed to persist reauth state",
      error.message,
    );
  }
}
