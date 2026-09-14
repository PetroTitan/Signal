import "server-only";
/**
 * Resolving a Bluesky identity's session for RELATIONSHIP work.
 *
 * This is the impure counterpart to `atproto-graph.ts`: it loads the
 * identity's stored connection, decrypts the access JWT, and hands the
 * caller a `(did, handle, accessJwt)` plus a `refreshOnce()`
 * continuation.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PUBLISH ORCHESTRATOR
 * -------------------------------------------------------
 * `core/publishing/bluesky-publish-orchestrator.ts` already performs
 * exactly this dance, but it is welded to publishing: it returns
 * `PublishOutcome`, it runs the shape-binding gate, it prepares
 * provider media, and it owns the retry of a *post*. Relationship
 * actions need none of that and must not import it — the brief is
 * explicit that relationship actions are a separate subsystem from
 * publishing execution.
 *
 * The alternative — refactoring the orchestrator to share a base —
 * would mean editing the publish path, which this milestone is not
 * allowed to change. So the *lifecycle* is reproduced here with the
 * same rules, and the orchestrator is left byte-for-byte alone:
 *
 *   - the session is looked up by (workspace, account, "bluesky"), so
 *     identity A can never act through identity B's session;
 *   - plaintext JWTs exist only inside a caller's stack frame, never in
 *     a return value that outlives the call, never in a log line, never
 *     in a database column, never in an error message;
 *   - refresh happens AT MOST ONCE per operation, driven by a 401, and
 *     never recurses;
 *   - a refreshed session whose handle has drifted from the identity's
 *     declared handle is refused, not used;
 *   - there is no background loop and no automatic re-sign-in.
 *
 * The one behavioural difference from publishing: there is no legacy
 * workspace-credential fallback. Relationship mutations act *as* a
 * person's account and follow real people, so they require that
 * identity's own signed-in session and nothing else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getTokenCipher } from "@/core/platform-oauth";
import {
  decryptForOutboundUse,
  encryptTokenResponse,
} from "@/core/platform-oauth/token-storage";
import {
  getAccountById,
  setAccountConnectionStatus,
} from "@/repositories/account-repository";
import {
  getConnectionForAccount,
  markConnectionStatus,
  readEncryptedTokens,
  upsertPlatformConnection,
} from "@/repositories/platform-connection-repository";
import { refreshBlueskySession } from "@/core/identity-verifiers/bluesky-session";
import { normalizeBlueskyHandle } from "@/core/identity-verifiers/bluesky-resolve";
import { readBlueskyServiceUrl } from "@/core/publishing/platform-credentials";

export type RelationshipSessionErrorCode =
  | "identity_not_found"
  | "platform_mismatch"
  | "not_connected"
  | "session_unreadable"
  | "session_expired"
  | "handle_mismatch";

export interface RelationshipSessionError {
  ok: false;
  code: RelationshipSessionErrorCode;
  message: string;
}

export interface RelationshipSession {
  ok: true;
  /** The operator's DID. The repo every follow record is written to. */
  actorDid: string;
  actorHandle: string;
  /**
   * Decrypted access JWT.
   *
   * Treat as radioactive: pass it to a provider call and let it fall out
   * of scope. It must never be written to a row, returned to a client,
   * embedded in an error, or logged.
   */
  accessJwt: string;
  /** PDS service URL for writes. */
  service: string;
  connectionId: string;
  /**
   * Exchange the refresh token for a new session, ONCE.
   *
   * Returns the new session on success. On failure it marks the
   * connection expired and returns an error — it does not throw, and it
   * does not refresh a second time. A caller that has already called
   * this must stop rather than call it again.
   */
  refreshOnce: () => Promise<RelationshipSession | RelationshipSessionError>;
}

export type ResolveRelationshipSessionResult =
  | RelationshipSession
  | RelationshipSessionError;

const CONNECTED_ENOUGH = new Set([
  "connected",
  "expired",
  "reauthorization_required",
]);

/**
 * Load and decrypt the Bluesky session belonging to ONE identity.
 *
 * Every lookup below is scoped by workspaceId as well as accountId, so
 * a caller that has authenticated the wrong workspace cannot read a
 * session out of another one even with a valid account id.
 */
export async function resolveRelationshipSession(input: {
  workspaceId: string;
  accountId: string;
  db?: SupabaseClient;
  /**
   * The transport a refresh uses. Threaded from the caller so the
   * refresh goes through the SAME transport as the provider calls it
   * repairs — and so a test can drive the real refresh path against a
   * double instead of mocking this module away, which is how the
   * cross-chunk session defect stayed invisible.
   */
  fetchImpl?: typeof fetch;
}): Promise<ResolveRelationshipSessionResult> {
  const { workspaceId, accountId, db, fetchImpl } = input;

  let identity;
  try {
    identity = await getAccountById(workspaceId, accountId, db);
  } catch {
    return {
      ok: false,
      code: "identity_not_found",
      message: "That identity is not in this workspace.",
    };
  }
  if (identity.platform !== "bluesky") {
    return {
      ok: false,
      code: "platform_mismatch",
      message: `Relationship actions are Bluesky-only; this identity is on "${identity.platform}".`,
    };
  }

  const conn = await getConnectionForAccount(
    workspaceId,
    accountId,
    "bluesky" as never,
    db,
  );
  if (
    !conn ||
    !conn.hasAccessToken ||
    !CONNECTED_ENOUGH.has(conn.connectionStatus)
  ) {
    return {
      ok: false,
      code: "not_connected",
      message:
        "This Bluesky identity is not signed in. Connect it from the identity's Manage panel before following or unfollowing anyone.",
    };
  }
  if (!getTokenCipher().isAvailable()) {
    return {
      ok: false,
      code: "session_unreadable",
      message:
        "Server session encryption is not configured, so the stored Bluesky session cannot be read. Ask an administrator to configure TOKEN_ENCRYPTION_KEY.",
    };
  }

  const actorDid = conn.providerAccountId;
  if (!actorDid || !actorDid.startsWith("did:")) {
    return {
      ok: false,
      code: "not_connected",
      message:
        "The stored Bluesky connection has no DID, so Signal cannot tell which account it would act as. Reconnect the identity.",
    };
  }

  const enc = await readEncryptedTokens(workspaceId, conn.id, db);
  const accessJwt = enc ? decryptForOutboundUse(enc.accessTokenEncrypted) : null;
  if (!accessJwt) {
    return {
      ok: false,
      code: "session_unreadable",
      message: "The stored Bluesky session could not be decrypted.",
    };
  }

  const service = readBlueskyServiceUrl();
  const declaredHandle = identity.handle;

  return buildSession({
    workspaceId,
    accountId,
    connectionId: conn.id,
    actorDid,
    actorHandle: conn.handle ?? identity.handle ?? "",
    accessJwt,
    service,
    declaredHandle,
    db,
    fetchImpl,
    refreshAllowed: true,
  });
}

function buildSession(ctx: {
  workspaceId: string;
  accountId: string;
  connectionId: string;
  actorDid: string;
  actorHandle: string;
  accessJwt: string;
  service: string;
  declaredHandle: string | null;
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  /**
   * False on a session produced BY a refresh. That session's
   * `refreshOnce` refuses, which is what enforces "at most one refresh
   * per operation" structurally rather than by asking callers to keep
   * count.
   */
  refreshAllowed: boolean;
}): RelationshipSession {
  return {
    ok: true,
    actorDid: ctx.actorDid,
    actorHandle: ctx.actorHandle,
    accessJwt: ctx.accessJwt,
    service: ctx.service,
    connectionId: ctx.connectionId,
    refreshOnce: async () => {
      if (!ctx.refreshAllowed) {
        return {
          ok: false,
          code: "session_expired",
          message:
            "The Bluesky session was already refreshed once during this operation and is still being rejected. Sign in again.",
        };
      }
      return performRefresh(ctx);
    },
  };
}

async function performRefresh(ctx: {
  workspaceId: string;
  accountId: string;
  connectionId: string;
  service: string;
  declaredHandle: string | null;
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
}): Promise<RelationshipSession | RelationshipSessionError> {
  const enc = await readEncryptedTokens(
    ctx.workspaceId,
    ctx.connectionId,
    ctx.db,
  );
  const refreshJwt = enc?.refreshTokenEncrypted
    ? decryptForOutboundUse(enc.refreshTokenEncrypted)
    : null;
  if (!refreshJwt) {
    await markExpired(ctx, "Access token rejected and no refresh token is stored.");
    return {
      ok: false,
      code: "session_expired",
      message:
        "The Bluesky session expired and there is no refresh token to renew it. Sign in again.",
    };
  }

  const refreshed = await refreshBlueskySession({
    refreshJwt,
    service: ctx.service,
    fetchImpl: ctx.fetchImpl,
  });
  if (refreshed.outcome !== "refreshed") {
    await markExpired(ctx, `Refresh failed: ${refreshed.message}`);
    return {
      ok: false,
      code: "session_expired",
      message: `The Bluesky session could not be refreshed (${refreshed.code}). Sign in again.`,
    };
  }

  // Drift check. A refreshed session belonging to a different account
  // must never be used to follow or unfollow anyone — the operator
  // would be acting as someone they did not choose.
  const declared = normalizeBlueskyHandle(ctx.declaredHandle ?? "");
  const actual = normalizeBlueskyHandle(refreshed.handle);
  if (declared && actual && declared !== actual) {
    await markExpired(
      ctx,
      `Refreshed session belongs to ${refreshed.handle}, but the identity expected ${ctx.declaredHandle}.`,
    );
    return {
      ok: false,
      code: "handle_mismatch",
      message:
        "The refreshed Bluesky session belongs to a different account. No relationship action was taken. Sign in again with the correct account.",
    };
  }

  // Persist the new tokens. The encrypted blobs are what cross this
  // boundary; the plaintext stays in this frame.
  const encrypted = encryptTokenResponse({
    platform: "bluesky",
    response: {
      accessToken: refreshed.accessJwt,
      refreshToken: refreshed.refreshJwt,
      expiresInSeconds: null,
      scopes: [],
    },
  });
  if (!encrypted.ok) {
    await markExpired(ctx, `Refreshed but encryption refused: ${encrypted.reason}`);
    return {
      ok: false,
      code: "session_unreadable",
      message:
        "The session was refreshed but could not be stored securely, so it was discarded. Ask an administrator to configure TOKEN_ENCRYPTION_KEY.",
    };
  }

  try {
    await upsertPlatformConnection(
      {
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        platform: "bluesky",
        providerAccountId: refreshed.did,
        handle: refreshed.handle,
        displayName: refreshed.handle,
        scopes: [],
        accessTokenEncrypted: encrypted.accessTokenEncrypted,
        refreshTokenEncrypted: encrypted.refreshTokenEncrypted,
        expiresAt: encrypted.expiresAt,
        connectionStatus: "connected",
        metadata: {
          verification_method: "atproto.server.refreshSession",
          last_message: `Session refreshed for ${refreshed.handle}.`,
        },
      },
      ctx.db,
    );
  } catch (err) {
    // The refresh itself worked; failing to store it means the next
    // operation will refresh again, which is wasteful but correct.
    console.error("[bluesky-rel/session] persisting refreshed session failed", err);
  }

  return buildSession({
    ...ctx,
    actorDid: refreshed.did,
    actorHandle: refreshed.handle,
    accessJwt: refreshed.accessJwt,
    // Structurally prevents a second refresh in this operation.
    refreshAllowed: false,
  });
}

async function markExpired(
  ctx: {
    workspaceId: string;
    accountId: string;
    connectionId: string;
    db?: SupabaseClient;
  },
  message: string,
): Promise<void> {
  try {
    await markConnectionStatus(
      {
        workspaceId: ctx.workspaceId,
        connectionId: ctx.connectionId,
        status: "expired",
        healthStatus: "expired",
        message,
      },
      ctx.db,
    );
  } catch (err) {
    console.error("[bluesky-rel/session] markConnectionStatus failed", err);
  }
  try {
    await setAccountConnectionStatus(
      {
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        connectionStatus: "expired",
      },
      ctx.db,
    );
  } catch (err) {
    console.error("[bluesky-rel/session] growth_accounts mirror failed", err);
  }
}
