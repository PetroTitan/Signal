import "server-only";
/**
 * Shared X token access for the metrics subsystem.
 *
 * Extracted so the post-metrics reader and the account-snapshot reader
 * resolve tokens through ONE path. Two copies would eventually disagree
 * about refresh, reauth or decryption, and the disagreement would show
 * up as metrics that work on one screen and not another.
 *
 * Hard rules, enforced here rather than at each call site:
 *   - never starts a reauthorization flow; a token needing reauth is
 *     reported as a reason string for a human to act on
 *   - never changes stored scopes
 *   - never logs, returns or embeds a token value in an error
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureFreshXAccessToken } from "@/core/platform-oauth/x-token-refresh";
import { getTokenCipher } from "@/core/platform-oauth/token-encryption";
import {
  getConnectionForAccount,
  readEncryptedTokens,
} from "@/repositories/platform-connection-repository";

export interface XTokenContext {
  db: SupabaseClient;
  workspaceId: string;
  /** growth_accounts.id of the publishing identity. */
  accountId: string | null;
  nowIso?: string;
}

export type XTokenResolution =
  | { ok: true; accessToken: string; connectionId: string }
  | { ok: false; reason: string };

/**
 * Resolve a usable access token for the identity, refreshing it if it is
 * about to expire. Deliberately mirrors the publisher's path so a token
 * that can publish can also be read with.
 */
export async function resolveXAccessTokenForMetrics(
  ctx: XTokenContext,
): Promise<XTokenResolution> {
  if (!ctx.accountId) {
    return { ok: false, reason: "No account id for this publication." };
  }

  let connection;
  try {
    connection = await getConnectionForAccount(
      ctx.workspaceId,
      ctx.accountId,
      "x",
      ctx.db,
    );
  } catch (err) {
    return {
      ok: false,
      reason: `Could not load the X connection: ${err instanceof Error ? err.message : "unknown error"}.`,
    };
  }

  if (!connection) {
    return {
      ok: false,
      reason: "No X connection is attached to this identity.",
    };
  }
  if (connection.connectionStatus !== "connected") {
    return {
      ok: false,
      reason: `The X connection is ${connection.connectionStatus}; reconnect it to read metrics.`,
    };
  }

  const tokens = await readTokens(ctx, connection.id);
  if (!tokens) {
    return { ok: false, reason: "No stored tokens for the X connection." };
  }

  const refreshed = await ensureFreshXAccessToken({
    db: ctx.db,
    workspaceId: ctx.workspaceId,
    connectionId: connection.id,
    currentAccessTokenEncrypted: tokens.accessTokenEncrypted,
    currentRefreshTokenEncrypted: tokens.refreshTokenEncrypted,
    currentExpiresAt: tokens.expiresAt,
    nowIso: ctx.nowIso ?? new Date().toISOString(),
  });

  if (refreshed.outcome.kind === "reauthorization_required") {
    return {
      ok: false,
      reason:
        "The X connection needs reauthorization before metrics can be read. " +
        "Reconnect it from the identity card. (Metrics never trigger a " +
        "reauthorization flow on their own.)",
    };
  }
  if (refreshed.outcome.kind === "transient_error") {
    return {
      ok: false,
      reason: `X token refresh failed transiently: ${refreshed.outcome.reason}`,
    };
  }
  if (!refreshed.accessTokenEncrypted) {
    return { ok: false, reason: "No X access token is stored for this identity." };
  }

  const cipher = getTokenCipher();
  if (!cipher.isAvailable()) {
    return {
      ok: false,
      reason:
        "Token decryption is unavailable in this environment " +
        "(TOKEN_ENCRYPTION_KEY is unset), so the X token cannot be used.",
    };
  }
  const accessToken = cipher.decrypt(refreshed.accessTokenEncrypted);
  if (!accessToken) {
    return { ok: false, reason: "The stored X access token could not be decrypted." };
  }
  return { ok: true, accessToken, connectionId: connection.id };
}

async function readTokens(ctx: XTokenContext, connectionId: string) {
  try {
    return await readEncryptedTokens(ctx.workspaceId, connectionId, ctx.db);
  } catch {
    return null;
  }
}

