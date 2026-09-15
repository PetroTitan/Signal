import "server-only";
/**
 * Resolving a Bluesky identity's session for RELATIONSHIP work — and
 * the ONE place its refresh is coordinated.
 *
 * This is the impure counterpart to `atproto-graph.ts`: it loads the
 * identity's stored connection, decrypts the access JWT, and hands the
 * caller a `(did, handle, accessJwt)` plus a `refreshOnce()`
 * continuation.
 *
 * THE IDENTITY IS THE UNIT, NOT THE CAMPAIGN
 * ------------------------------------------
 * Access and refresh tokens belong to the identity (workspace, account,
 * "bluesky"), and Bluesky refresh tokens ROTATE: presenting one rotates
 * it, and every later presentation of the same token is refused. Any
 * two workers sharing an identity — two campaigns, a follow and an
 * unfollow campaign, the publishing scheduler on the same cron, a
 * duplicate cron delivery, the operator's "Check account access" — that
 * refresh independently race for a single-use credential, and the loser
 * used to write `expired` over the winner's freshly stored, valid pair.
 * That is the 2026-09-15 production incident.
 *
 * So a refresh is coordinated in the DATABASE, never in this process
 * (Vercel invocations do not share memory):
 *
 *   1. the worker observes a refreshable rejection (ExpiredToken);
 *   2. it asks for the identity's refresh LEASE, quoting the token
 *      generation it read its session at;
 *   3. `reload`  — the stored generation moved: another worker already
 *                  refreshed or the operator reconnected. It reloads
 *                  the latest session and calls NO provider refresh;
 *      `busy`    — another worker holds the lease: it waits briefly and
 *                  asks again;
 *      `acquired`— it refreshes EXACTLY ONCE, then commits the rotated
 *                  pair atomically with generation+1, connected/healthy,
 *                  the identity mirror, AND the recovery of every
 *                  campaign and run of that identity;
 *   4. a failed refresh may mark the identity reauthorization_required
 *      ONLY while it still owns the lease, on the generation it
 *      attempted, and only for a DEFINITIVE rejection. A stale worker
 *      can never overwrite newer healthy credentials. A transient
 *      failure (network, 5xx, lease wait exhausted) changes nothing.
 *
 * The rules that carry over unchanged:
 *   - the session is looked up by (workspace, account, "bluesky"), so
 *     identity A can never act through identity B's session;
 *   - plaintext JWTs exist only inside a caller's stack frame, never in
 *     a return value that outlives the call, never in a log line, never
 *     in a database column, never in an error message;
 *   - refresh happens AT MOST ONCE per operation, driven by a
 *     refreshable rejection, and never recurses;
 *   - a refreshed session whose handle has drifted from the identity's
 *     declared handle is refused, not used;
 *   - there is no background loop and no automatic re-sign-in.
 *
 * There is no legacy workspace-credential fallback: relationship
 * mutations act *as* a person's account and require that identity's own
 * signed-in session and nothing else.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTokenCipher } from "@/core/platform-oauth";
import {
  decryptForOutboundUse,
  encryptTokenResponse,
} from "@/core/platform-oauth/token-storage";
import { getAccountById } from "@/repositories/account-repository";
import {
  acquireBlueskyRefreshLease,
  commitBlueskyRefreshedSession,
  failBlueskyRefresh,
  getConnectionForAccount,
  readEncryptedTokens,
  releaseBlueskyRefreshLease,
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
  | "handle_mismatch"
  /**
   * The refresh could not be completed for a reason that says nothing
   * about the credential: the provider was unreachable or answered 5xx,
   * or another worker held the identity's refresh lease for longer than
   * this caller could wait. The identity is untouched. Retry later.
   */
  | "provider_unavailable";

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
   * `platform_connections.connection_status` read in the SAME query as
   * the token. Only `connected` may drive provider mutations; the
   * dispatchers stop — without a provider call — for anything else.
   */
  connectionStatus: string;
  /**
   * `platform_connections.token_generation` read in the same query as
   * the token. Quoted back to the coordinator, so a refresh is only
   * ever attempted against the generation this session came from.
   */
  tokenGeneration: number;
  /**
   * Obtain a working session after a refreshable rejection, ONCE.
   *
   * Coordinated per identity (see the module comment). Returns the
   * renewed session, or the newer session another worker already
   * stored, or an error whose code says whether the identity now needs
   * the operator (`session_expired`, `handle_mismatch`) or nothing
   * changed (`provider_unavailable`). It does not throw on provider
   * failure, and it never refreshes twice: the session it returns
   * refuses a second refresh.
   */
  refreshOnce: () => Promise<RelationshipSession | RelationshipSessionError>;
}

export type ResolveRelationshipSessionResult =
  | RelationshipSession
  | RelationshipSessionError;

/**
 * Statuses under which a stored session is loaded and may be TRIED.
 * `expired` and `reauthorization_required` are included so the operator's
 * "Check account access" can exercise a session the system stopped
 * trusting; the coordinator decides whether a refresh may run.
 */
const CONNECTED_ENOUGH = new Set([
  "connected",
  "expired",
  "reauthorization_required",
]);

/** How long a refresh lease lives if its owner dies. */
export const REFRESH_LEASE_SECONDS = 30;
/** How long a worker waits on a `busy` lease before yielding. */
export const REFRESH_WAIT_MS = 12_000;
/** Poll interval while waiting on a busy lease. */
export const REFRESH_POLL_MS = 250;

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
  /** Injected in tests; the wait on a busy lease uses it. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait on a busy lease before reporting `provider_unavailable`. */
  refreshWaitMs?: number;
  /**
   * The caller's clock. A dispatcher tick works from ONE injected
   * instant; the coordinator's commit and failure stamps use the same
   * one, so a recovered campaign is due on the tick's clock, not the
   * database's. Defaults to the database's now().
   */
  nowIso?: string;
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

  const ctx: CoordinatorContext = {
    workspaceId,
    accountId,
    connectionId: conn.id,
    service: readBlueskyServiceUrl(),
    declaredHandle: identity.handle,
    fallbackHandle: conn.handle ?? identity.handle ?? "",
    fallbackDid: actorDid,
    db,
    fetchImpl,
    sleep: input.sleep,
    refreshWaitMs: input.refreshWaitMs,
    nowIso: input.nowIso,
  };

  return loadSession(ctx, { refreshAllowed: true });
}

interface CoordinatorContext {
  workspaceId: string;
  accountId: string;
  connectionId: string;
  service: string;
  declaredHandle: string | null;
  fallbackHandle: string;
  fallbackDid: string;
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  refreshWaitMs?: number;
  nowIso?: string;
}

/**
 * Read the token row ONCE (token, generation and status together) and
 * build a session from it.
 */
async function loadSession(
  ctx: CoordinatorContext,
  opts: { refreshAllowed: boolean; actorDid?: string; actorHandle?: string },
): Promise<RelationshipSession | RelationshipSessionError> {
  const enc = await readEncryptedTokens(ctx.workspaceId, ctx.connectionId, ctx.db);
  const accessJwt = enc ? decryptForOutboundUse(enc.accessTokenEncrypted) : null;
  if (!enc || !accessJwt) {
    return {
      ok: false,
      code: "session_unreadable",
      message: "The stored Bluesky session could not be decrypted.",
    };
  }
  return buildSession(ctx, {
    actorDid: opts.actorDid ?? ctx.fallbackDid,
    actorHandle: opts.actorHandle ?? ctx.fallbackHandle,
    accessJwt,
    connectionStatus: enc.connectionStatus,
    tokenGeneration: enc.tokenGeneration,
    refreshAllowed: opts.refreshAllowed,
  });
}

function buildSession(
  ctx: CoordinatorContext,
  s: {
    actorDid: string;
    actorHandle: string;
    accessJwt: string;
    connectionStatus: string;
    tokenGeneration: number;
    /**
     * False on a session produced BY a refresh or a reload. That
     * session's `refreshOnce` refuses, which is what enforces "at most
     * one refresh per operation" structurally rather than by asking
     * callers to keep count.
     */
    refreshAllowed: boolean;
  },
): RelationshipSession {
  return {
    ok: true,
    actorDid: s.actorDid,
    actorHandle: s.actorHandle,
    accessJwt: s.accessJwt,
    service: ctx.service,
    connectionId: ctx.connectionId,
    connectionStatus: s.connectionStatus,
    tokenGeneration: s.tokenGeneration,
    refreshOnce: async () => {
      if (!s.refreshAllowed) {
        return {
          ok: false,
          code: "session_expired",
          message:
            "The Bluesky session was already refreshed once during this operation and is still being rejected. Sign in again.",
        };
      }
      return coordinateRefresh(ctx, s.tokenGeneration);
    },
  };
}

/**
 * Refresh an identity's session through the shared coordinator.
 *
 * Exported for the ONE other refresh participant on the same identity —
 * the publishing orchestrator — so there is exactly one implementation
 * of "spend the refresh token" in the codebase. Callers pass the
 * generation they read the failing access token at.
 */
export async function refreshIdentitySession(input: {
  workspaceId: string;
  accountId: string;
  connectionId: string;
  declaredHandle: string | null;
  /** The generation the rejected access token was read at. */
  observedGeneration: number;
  service?: string;
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  refreshWaitMs?: number;
  nowIso?: string;
}): Promise<RelationshipSession | RelationshipSessionError> {
  const ctx: CoordinatorContext = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    connectionId: input.connectionId,
    service: input.service ?? readBlueskyServiceUrl(),
    declaredHandle: input.declaredHandle,
    fallbackHandle: input.declaredHandle ?? "",
    fallbackDid: "",
    db: input.db,
    fetchImpl: input.fetchImpl,
    sleep: input.sleep,
    refreshWaitMs: input.refreshWaitMs,
    nowIso: input.nowIso,
  };
  return coordinateRefresh(ctx, input.observedGeneration);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function coordinateRefresh(
  ctx: CoordinatorContext,
  observedGeneration: number,
): Promise<RelationshipSession | RelationshipSessionError> {
  const owner = `refresh-${randomUUID()}`;
  const sleep = ctx.sleep ?? defaultSleep;
  const waitMs = ctx.refreshWaitMs ?? REFRESH_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let polls = 0;

  for (;;) {
    let lease;
    try {
      lease = await acquireBlueskyRefreshLease(
        {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId,
          owner,
          observedGeneration,
          leaseSeconds: REFRESH_LEASE_SECONDS,
        },
        ctx.db,
      );
    } catch (err) {
      // The coordinator itself could not be reached (or the caller has
      // no service client). Nothing about the identity changed.
      return {
        ok: false,
        code: "provider_unavailable",
        message: `The session refresh could not be coordinated: ${
          err instanceof Error ? err.message : "unknown error"
        }. Nothing changed; it will be retried.`,
      };
    }

    switch (lease.verdict) {
      case "reload":
        // Another worker already refreshed, or the operator reconnected.
        // The latest stored session is the one to use; no provider
        // refresh is spent here.
        return reloadLatest(ctx);
      case "reauthorization_required":
        return {
          ok: false,
          code: "session_expired",
          message:
            "This Bluesky identity needs to be signed in again before Signal can act as it.",
        };
      case "not_connected":
        return {
          ok: false,
          code: "not_connected",
          message: "This Bluesky identity is not signed in.",
        };
      case "busy": {
        // Someone else is refreshing this identity right now. Wait for
        // them — bounded — then ask again; their commit will move the
        // generation and we will be told to reload.
        // Bounded by wall clock. The poll counter is only a floor
        // under an injected sleep that returns at once, so a test with
        // a no-op sleep cannot hammer the database for the whole wait.
        polls += 1;
        if (Date.now() >= deadline || polls > Math.ceil(waitMs / REFRESH_POLL_MS) * 8) {
          return {
            ok: false,
            code: "provider_unavailable",
            message:
              "Another worker is refreshing this identity's session and did not finish in time. Nothing changed; the next delivery retries.",
          };
        }
        await sleep(REFRESH_POLL_MS);
        continue;
      }
      case "acquired":
        return refreshUnderLease(ctx, owner, lease.generation ?? observedGeneration);
      default:
        return {
          ok: false,
          code: "provider_unavailable",
          message: `Unexpected refresh lease verdict "${String(lease.verdict)}".`,
        };
    }
  }
}

/** Reload whatever is stored now — after someone else's successful refresh or reconnect. */
async function reloadLatest(
  ctx: CoordinatorContext,
): Promise<RelationshipSession | RelationshipSessionError> {
  const enc = await readEncryptedTokens(ctx.workspaceId, ctx.connectionId, ctx.db);
  if (!enc) {
    return { ok: false, code: "not_connected", message: "This Bluesky identity is not signed in." };
  }
  if (!CONNECTED_ENOUGH.has(enc.connectionStatus) || enc.connectionStatus !== "connected") {
    return {
      ok: false,
      code: "session_expired",
      message:
        "This Bluesky identity needs to be signed in again before Signal can act as it.",
    };
  }
  const accessJwt = decryptForOutboundUse(enc.accessTokenEncrypted);
  if (!accessJwt) {
    return {
      ok: false,
      code: "session_unreadable",
      message: "The stored Bluesky session could not be decrypted.",
    };
  }
  const conn = await getConnectionForAccount(
    ctx.workspaceId,
    ctx.accountId,
    "bluesky" as never,
    ctx.db,
  );
  return buildSession(ctx, {
    actorDid: conn?.providerAccountId ?? ctx.fallbackDid,
    actorHandle: conn?.handle ?? ctx.fallbackHandle,
    accessJwt,
    connectionStatus: enc.connectionStatus,
    tokenGeneration: enc.tokenGeneration,
    // A reloaded session is at most a lease's age old. It refuses to
    // refresh again in this operation, like a refreshed one.
    refreshAllowed: false,
  });
}

async function refreshUnderLease(
  ctx: CoordinatorContext,
  owner: string,
  generation: number,
): Promise<RelationshipSession | RelationshipSessionError> {
  const release = async () => {
    try {
      await releaseBlueskyRefreshLease(
        { workspaceId: ctx.workspaceId, accountId: ctx.accountId, owner },
        ctx.db,
      );
    } catch (err) {
      console.error("[bluesky-rel/session] releasing the refresh lease failed", err);
    }
  };
  const fail = async (definitive: boolean, message: string) => {
    try {
      return await failBlueskyRefresh(
        {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId,
          owner,
          expectedGeneration: generation,
          definitive,
          message,
          nowIso: ctx.nowIso,
        },
        ctx.db,
      );
    } catch (err) {
      console.error("[bluesky-rel/session] recording the failed refresh failed", err);
      return null;
    }
  };

  try {
    // Under the lease: read the refresh token at the generation we own.
    // A different generation here means someone moved it between our
    // lease and this read (a reconnect through the App Password path,
    // which does not take the lease); theirs stands.
    const enc = await readEncryptedTokens(ctx.workspaceId, ctx.connectionId, ctx.db);
    if (!enc || enc.tokenGeneration !== generation) {
      await release();
      return reloadLatest(ctx);
    }
    const refreshJwt = enc.refreshTokenEncrypted
      ? decryptForOutboundUse(enc.refreshTokenEncrypted)
      : null;
    if (!refreshJwt) {
      await fail(true, "Access token rejected and no refresh token is stored.");
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
      // Only a REJECTED refresh token says anything about the
      // credential. A network error or a 5xx is the provider having a
      // bad moment: the identity is left exactly as it was.
      const definitive =
        refreshed.code === "refresh_rejected" ||
        refreshed.code === "missing_refresh_token";
      const verdict = await fail(definitive, `Refresh failed: ${refreshed.message}`);
      if (!definitive) {
        return {
          ok: false,
          code: "provider_unavailable",
          message: `Bluesky could not be reached to refresh the session (${refreshed.code}). Nothing changed; the next delivery retries.`,
        };
      }
      if (verdict && verdict.reason === "generation_moved") {
        // Our refresh token was refused BECAUSE someone else had already
        // rotated it and stored the result. Use theirs.
        return reloadLatest(ctx);
      }
      return {
        ok: false,
        code: "session_expired",
        message: `The Bluesky session could not be refreshed (${refreshed.code}). Sign in again.`,
      };
    }

    // Drift check. A refreshed session belonging to a different account
    // must never be used to follow or unfollow anyone — the operator
    // would be acting as someone they did not choose. The provider has
    // rotated the token, so the stored credential is now dead either
    // way: this is definitive.
    const declared = normalizeBlueskyHandle(ctx.declaredHandle ?? "");
    const actual = normalizeBlueskyHandle(refreshed.handle);
    if (declared && actual && declared !== actual) {
      await fail(
        true,
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
      await fail(true, `Refreshed but encryption refused: ${encrypted.reason}`);
      return {
        ok: false,
        code: "session_unreadable",
        message:
          "The session was refreshed but could not be stored securely, so it was discarded. Ask an administrator to configure TOKEN_ENCRYPTION_KEY.",
      };
    }

    let commit;
    try {
      commit = await commitBlueskyRefreshedSession(
        {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId,
          owner,
          expectedGeneration: generation,
          accessTokenEncrypted: encrypted.accessTokenEncrypted,
          refreshTokenEncrypted: encrypted.refreshTokenEncrypted,
          providerAccountId: refreshed.did,
          handle: refreshed.handle,
          message: `Session refreshed for ${refreshed.handle}.`,
          nowIso: ctx.nowIso,
        },
        ctx.db,
      );
    } catch (err) {
      // The refresh itself worked but could not be stored. The rotated
      // pair in this frame is the identity's only valid credential and
      // it is about to be lost; report it as unavailable (nothing was
      // marked) and let the next attempt find out what is stored.
      console.error("[bluesky-rel/session] persisting refreshed session failed", err);
      await release();
      return {
        ok: false,
        code: "provider_unavailable",
        message: "The refreshed session could not be stored. Nothing changed; the next delivery retries.",
      };
    }
    if (!commit.committed) {
      // Someone persisted a newer generation while our provider call
      // was in flight (a reconnect). Theirs stands; ours is discarded.
      return reloadLatest(ctx);
    }

    return buildSession(ctx, {
      actorDid: refreshed.did,
      actorHandle: refreshed.handle,
      accessJwt: refreshed.accessJwt,
      connectionStatus: "connected",
      tokenGeneration: commit.generation ?? generation + 1,
      // Structurally prevents a second refresh in this operation.
      refreshAllowed: false,
    });
  } catch (err) {
    await release();
    throw err;
  }
}
