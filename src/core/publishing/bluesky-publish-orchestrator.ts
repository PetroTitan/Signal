import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
/**
 * Bluesky identity-session publish orchestrator.
 *
 * The pure publisher in `publish-bluesky.ts` posts under a given
 * (did, accessJwt). This module owns the impure parts: loading the
 * identity's encrypted session, decrypting, calling the publisher,
 * handling 401 with exactly one refresh attempt, persisting new
 * tokens, and surfacing mismatch state if the refreshed handle
 * drifts away from the identity's declared handle.
 *
 * Strict scope rules (matches the brief):
 *
 *   - Publishing uses the signed-in session belonging to THIS
 *     identity. The lookup is keyed by (workspace, account, "bluesky")
 *     so identity A can never accidentally publish through identity
 *     B's session.
 *
 *   - No background loops. No automatic re-sign-in. At most one
 *     refresh attempt per publish call. On refresh failure, the
 *     identity's connection is marked expired/revoked and publishing
 *     stops safely.
 *
 *   - On mismatch after refresh (DID/handle no longer matches the
 *     identity's declared handle), the connection is marked 'error'
 *     with metadata.handle_mismatch and publishing is blocked. The
 *     existing resolver short-circuits to "mismatched" so the UI
 *     surfaces it immediately.
 *
 *   - No tokens / app passwords appear in any returned outcome
 *     metadata, log line, or error message. Encrypted blobs cross
 *     module boundaries; plaintext is held only in the runner stack
 *     frame for the duration of the publish + refresh round-trips.
 *
 *   - The optional legacy workspace-fallback path is reachable only
 *     when (a) no identity session exists AND (b)
 *     BLUESKY_LEGACY_FALLBACK is explicitly enabled. Default behaviour
 *     fails safe with "session_missing".
 */

import {
  decryptForOutboundUse,
  getTokenCipher,
} from "@/core/platform-oauth";
import { encryptTokenResponse } from "@/core/platform-oauth/token-storage";
import {
  getAccountById,
  setAccountConnectionStatus,
} from "@/repositories/account-repository";
import {
  getConnectionForAccount,
  markConnectionStatus,
  upsertPlatformConnection,
} from "@/repositories/platform-connection-repository";
import { refreshBlueskySession } from "@/core/identity-verifiers/bluesky-session";
import { normalizeBlueskyHandle } from "@/core/identity-verifiers/bluesky-resolve";
import {
  publishToBluesky,
  publishToBlueskyAsIdentity,
} from "./publish-bluesky";
import {
  isBlueskyLegacyFallbackEnabled,
  readBlueskyCredentials,
  readBlueskyServiceUrl,
} from "./platform-credentials";
import { publishBlocked, publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { decideBlueskyPublishGate } from "@/core/platform-native/adapters/bluesky/shape-binding";
import { resolveProviderMediaForPublish } from "@/core/creatives/resolve-provider-derivative";

export interface OrchestratorInput {
  request: PublishRequest;
  /**
   * Optional Supabase client. Forwarded to every repository call the
   * orchestrator makes so the cron-triggered scheduler tick (no
   * operator cookie) can read growth_accounts / platform_connections
   * under service-role auth. Manual / UI callers omit this and fall
   * back to the cookie-aware client, which RLS allows for the
   * operator's own workspace rows.
   *
   * The orchestrator itself never directly issues SQL — it threads
   * this through to the repos and to the helper functions
   * (markIdentityExpired / markIdentityMismatched).
   */
  db?: SupabaseClient;
}

/**
 * Resolves the publish path for a Bluesky request:
 *   1. Load the identity row + its platform_connections row.
 *   2. If the identity has encrypted access JWTs, use the per-
 *      identity path. On 401, refresh + retry once. On refresh
 *      failure, mark the connection expired and fail safely. On
 *      DID/handle drift after refresh, mark mismatched.
 *   3. If no encrypted session AND fallback is enabled, fall back to
 *      the workspace credentials with a clear isolated marker. Other-
 *      wise fail with `session_missing`.
 *
 * Identity-scoped throughout. Touches only the (workspace, account,
 * "bluesky") row.
 */
export async function publishBlueskyForIdentity(
  input: OrchestratorInput,
): Promise<PublishOutcome> {
  const { request, db } = input;

  if (!request.accountId) {
    return publishFail(
      "missing_account",
      "Bluesky publish requires an identity (accountId).",
    );
  }

  // 1. Identity row.
  let identity;
  try {
    identity = await getAccountById(request.workspaceId, request.accountId, db);
  } catch {
    return publishFail("missing_account", "Identity not found in workspace.");
  }
  if (identity.platform !== "bluesky") {
    return publishFail(
      "platform_mismatch",
      `Identity is on "${identity.platform}", not Bluesky.`,
    );
  }

  const service = readBlueskyServiceUrl();

  // 2. Connection row (per-identity).
  const conn = await getConnectionForAccount(
    request.workspaceId,
    request.accountId,
    "bluesky" as never,
    db,
  );

  // The identity-session path requires: a row exists, the row has
  // encrypted access JWT, connection_status is healthy, and the
  // cipher is available to decrypt.
  const hasIdentitySession =
    conn !== null &&
    conn.hasAccessToken &&
    (conn.connectionStatus === "connected" ||
      conn.connectionStatus === "expired" ||
      conn.connectionStatus === "reauthorization_required") &&
    getTokenCipher().isAvailable();

  if (!hasIdentitySession) {
    if (isBlueskyLegacyFallbackEnabled()) {
      // LEGACY workspace-level fallback. Opt-in only. The outcome
      // metadata marks the path so audit logs make the fallback
      // visible.
      const creds = readBlueskyCredentials();
      if (!creds) {
        return publishFail(
          "session_missing",
          "Identity is not signed in to Bluesky and no legacy fallback credentials are configured.",
        );
      }
      const outcome = await publishToBluesky({
        request,
        identifier: creds.identifier,
        appPassword: creds.appPassword,
        service: creds.service,
      });
      return tagLegacyFallback(outcome);
    }
    return publishFail(
      "session_missing",
      "Bluesky identity is not signed in. Sign in via the Manage panel to enable publishing.",
    );
  }

  // 3. Identity-scoped path. Decrypt the access JWT for outbound use.
  // We re-fetch the raw encrypted columns because the domain
  // projection in PlatformConnection strips them (which is the
  // correct default — only the orchestrator should pull plaintext).
  const { readEncryptedTokens } = await import(
    "@/repositories/platform-connection-repository"
  );
  const enc = await readEncryptedTokens(request.workspaceId, conn!.id, db);
  if (!enc) {
    return publishFail(
      "session_missing",
      "Bluesky identity session present but unreadable.",
    );
  }
  const accessJwt = decryptForOutboundUse(enc.accessTokenEncrypted);
  if (!accessJwt) {
    return publishFail(
      "session_missing",
      "Bluesky session could not be decrypted.",
    );
  }

  const did = conn!.providerAccountId;
  const handle = conn!.handle ?? identity.handle ?? "";
  if (!did || !did.startsWith("did:")) {
    return publishFail(
      "session_missing",
      "Bluesky connection row is missing a DID.",
    );
  }

  // Phase F6.2 — shape-binding gate. Bluesky-only.
  //
  // Load weekly_plan_items.platform_publish_intent for THIS item
  // and decide whether the operator's approved payload shape still
  // matches what we're about to publish. Legacy rows (no envelope,
  // or envelope without operatorApprovedShapeHash) skip the gate —
  // current behavior preserved.
  //
  // CRITICAL: the gate runs BEFORE any provider call. A stale
  // approval must short-circuit before uploadBlob / createRecord.
  const gate = await loadAndCheckBlueskyShapeGate({
    request,
    db,
  });
  if (gate.kind === "block_stale") {
    return publishBlocked(
      "approved_shape_stale",
      gate.reasonDetail,
      {
        endpoint: null,
        approved_shape_hash: gate.approvedHash,
        current_shape_hash: gate.currentHash,
        plan_item_id: request.planItemId,
      },
    );
  }
  // gate.kind === "proceed" — fall through. payloadHash (when
  // present) becomes telemetry-only metadata after the publish
  // succeeds; we don't attach it here to keep the success-path
  // metadata stable for downstream consumers.
  void gate.payloadHash;

  // Provider-media preparation (Phase 2). Runs AFTER the shape gate so
  // the gate compares the operator-approved original. If the approved
  // image is too large for Bluesky, a provider-safe derivative is
  // generated + stored and the publish payload is rewritten to point at
  // it; the original creative is never mutated. A block here (oversized
  // GIF, transform failure, video, etc.) short-circuits BEFORE any
  // uploadBlob / createRecord — no text-only downgrade.
  const media = await resolveProviderMediaForPublish({
    platform: "bluesky",
    request,
    db,
  });
  if (media.kind === "blocked") return media.outcome;
  const effectiveRequest: PublishRequest =
    media.kind === "derivative"
      ? { ...request, creative: media.creative }
      : request;
  const mediaMetadata = media.metadata;
  // Merge media-prep metadata last so the derivative status wins over
  // the publisher's own (original-creative) preflight metadata.
  const tagMedia = (o: PublishOutcome): PublishOutcome => ({
    ...o,
    metadata: { ...o.metadata, ...mediaMetadata },
  });

  // First publish attempt.
  const firstOutcome = await publishToBlueskyAsIdentity({
    request: effectiveRequest,
    accessJwt,
    did,
    handle,
    service,
  });

  if (
    firstOutcome.status === "published" ||
    firstOutcome.reasonCode !== "session_expired"
  ) {
    return tagMedia(firstOutcome);
  }

  // 4. Refresh path. Exactly one attempt.
  const refreshJwt = enc.refreshTokenEncrypted
    ? decryptForOutboundUse(enc.refreshTokenEncrypted)
    : null;
  if (!refreshJwt) {
    await markIdentityExpired(
      request.workspaceId,
      request.accountId,
      conn!.id,
      "Access JWT expired; no refresh token available.",
      db,
    );
    return publishFail(
      "session_expired",
      "Bluesky session expired and no refresh token is available. Sign in again.",
    );
  }

  const refreshResult = await refreshBlueskySession({ refreshJwt, service });
  if (refreshResult.outcome !== "refreshed") {
    await markIdentityExpired(
      request.workspaceId,
      request.accountId,
      conn!.id,
      `Refresh failed: ${refreshResult.message}`,
      db,
    );
    return publishFail(
      "session_expired",
      `Bluesky session refresh failed (${refreshResult.code}). Sign in again.`,
    );
  }

  // 5. Mismatch check after refresh.
  const declaredNormalized = normalizeBlueskyHandle(identity.handle);
  const refreshedNormalized = normalizeBlueskyHandle(refreshResult.handle);
  if (
    declaredNormalized &&
    refreshedNormalized &&
    declaredNormalized !== refreshedNormalized
  ) {
    await markIdentityMismatched(
      request.workspaceId,
      request.accountId,
      conn!.id,
      {
        declared: identity.handle,
        authenticated: refreshResult.handle,
      },
      db,
    );
    return publishFail(
      "handle_mismatch",
      "Refreshed session belongs to a different Bluesky account. Sign in again with the correct account.",
    );
  }

  // 6. Encrypt + persist refreshed tokens. Keep all other row fields
  // intact (provider_account_id, scopes, etc.).
  const encrypted = encryptTokenResponse({
    platform: "bluesky",
    response: {
      accessToken: refreshResult.accessJwt,
      refreshToken: refreshResult.refreshJwt,
      expiresInSeconds: null,
      scopes: [],
    },
  });
  if (!encrypted.ok) {
    await markIdentityExpired(
      request.workspaceId,
      request.accountId,
      conn!.id,
      `Refreshed but encryption refused: ${encrypted.reason}`,
      db,
    );
    return publishFail(
      "session_expired",
      "Server session encryption is not configured correctly. Ask an administrator to configure TOKEN_ENCRYPTION_KEY and redeploy. The existing session will be marked expired and a fresh sign-in will be required after the key is configured.",
    );
  }

  // Persist via upsert — finds the existing row by (workspace,
  // account, platform) and updates in place. Metadata is replaced
  // wholesale; this is acceptable here because we're following a
  // successful refresh, not a sign-in flow, and the success-path
  // metadata carries no secrets.
  await upsertPlatformConnection(
    {
      workspaceId: request.workspaceId,
      accountId: request.accountId,
      platform: "bluesky",
      providerAccountId: refreshResult.did,
      handle: refreshResult.handle,
      displayName: refreshResult.handle,
      scopes: [],
      accessTokenEncrypted: encrypted.accessTokenEncrypted,
      refreshTokenEncrypted: encrypted.refreshTokenEncrypted,
      expiresAt: encrypted.expiresAt,
      connectionStatus: "connected",
      metadata: {
        verification_method: "atproto.server.refreshSession",
        last_message: `Session refreshed for ${refreshResult.handle}.`,
      },
    },
    db,
  );

  // 7. Retry publish exactly once with the fresh access JWT. The
  // pure publisher receives the new accessJwt; no recursion, no
  // further retry.
  const retry = await publishToBlueskyAsIdentity({
    request: effectiveRequest,
    accessJwt: refreshResult.accessJwt,
    did: refreshResult.did,
    handle: refreshResult.handle,
    service,
  });
  // If the retry also fails, the refresh path didn't help —
  // Bluesky is rejecting both tokens. Return whatever outcome the
  // retry produced and stop. No second refresh, no recursion.
  return tagMedia(retry);
}

async function markIdentityExpired(
  workspaceId: string,
  accountId: string,
  connectionId: string,
  message: string,
  db: SupabaseClient | undefined,
): Promise<void> {
  try {
    await markConnectionStatus(
      {
        workspaceId,
        connectionId,
        status: "expired",
        healthStatus: "expired",
        message,
        // Failed refresh is a "session-dead" signal; drop any prior
        // handle_mismatch payload that no longer reflects reality.
        clearMetadataKeys: ["handle_mismatch"],
      },
      db,
    );
  } catch (err) {
    console.error("[bluesky-orch] markConnectionStatus expired failed", err);
  }
  try {
    await setAccountConnectionStatus(
      {
        workspaceId,
        accountId,
        connectionStatus: "expired",
      },
      db,
    );
  } catch (err) {
    console.error(
      "[bluesky-orch] growth_accounts mirror expired failed",
      err,
    );
  }
}

async function markIdentityMismatched(
  workspaceId: string,
  accountId: string,
  connectionId: string,
  mismatch: { declared: string | null; authenticated: string },
  db: SupabaseClient | undefined,
): Promise<void> {
  try {
    // markConnectionStatus's metadata model is wholesale-replace
    // when we pass a message; for the mismatch case we need to set
    // an explicit handle_mismatch payload. Use upsert against the
    // same row (find-by-id semantics) to set the metadata cleanly
    // without disturbing the encrypted tokens.
    const { readEncryptedTokens } = await import(
      "@/repositories/platform-connection-repository"
    );
    const enc = await readEncryptedTokens(workspaceId, connectionId, db);
    await upsertPlatformConnection(
      {
        workspaceId,
        accountId,
        platform: "bluesky",
        providerAccountId: null,
        handle: mismatch.authenticated,
        displayName: mismatch.authenticated,
        scopes: [],
        // Persist nothing for tokens — we won't publish under the
        // wrong account.
        accessTokenEncrypted: null,
        refreshTokenEncrypted: enc?.refreshTokenEncrypted ?? null,
        expiresAt: null,
        connectionStatus: "error",
        metadata: {
          verification_method: "atproto.server.refreshSession",
          last_message: `Refreshed session belongs to ${mismatch.authenticated}, but identity expected ${mismatch.declared ?? "(unknown)"}.`,
          handle_mismatch: {
            declared: mismatch.declared,
            authenticated: mismatch.authenticated,
            observedAt: new Date().toISOString(),
          },
        },
      },
      db,
    );
  } catch (err) {
    console.error("[bluesky-orch] mark mismatched failed", err);
  }
  try {
    await setAccountConnectionStatus(
      {
        workspaceId,
        accountId,
        connectionStatus: "error",
      },
      db,
    );
  } catch (err) {
    console.error(
      "[bluesky-orch] growth_accounts mirror error failed",
      err,
    );
  }
}

/**
 * Wraps a legacy-fallback PublishOutcome with a metadata marker so
 * publish_history audit rows make the fallback path visible. Lets
 * us grep production data to find workspaces still relying on the
 * legacy shim.
 */
function tagLegacyFallback(outcome: PublishOutcome): PublishOutcome {
  return {
    ...outcome,
    metadata: {
      ...outcome.metadata,
      bluesky_publish_path: "legacy_workspace_fallback",
    },
  };
}

/**
 * Phase F6.2 — Bluesky-only: load the plan_item's
 * platform_publish_intent + the current creative, then ask the
 * shape-binding helper whether to gate the publish.
 *
 * Returns a "proceed" decision for ANY row that lacks an
 * operator-bound shape (legacy rows; MCP-prepared but never
 * approved). Returns "block_stale" only when an approved hash
 * exists AND the freshly-rendered payload no longer matches.
 *
 * No-op fallback: any error reading the row falls back to "proceed"
 * — we never let an observability failure block a publish that
 * would otherwise succeed.
 */
async function loadAndCheckBlueskyShapeGate(input: {
  request: PublishRequest;
  db?: SupabaseClient;
}): Promise<
  | { kind: "proceed"; payloadHash: string | null }
  | {
      kind: "block_stale";
      approvedHash: string;
      currentHash: string;
      reasonDetail: string;
    }
> {
  try {
    const { request } = input;
    const db = input.db;
    const { createSupabaseServerClient } = await import("@/lib/supabase");
    const client = db ?? createSupabaseServerClient();

    const { data: row } = await client
      .from("weekly_plan_items")
      .select("id, title, body, platform_publish_intent")
      .eq("workspace_id", request.workspaceId)
      .eq("id", request.planItemId)
      .maybeSingle();

    if (!row) {
      // Plan item not found — leave existing publisher behavior to
      // surface the right error. No gate.
      return { kind: "proceed", payloadHash: null };
    }
    const rawIntent =
      (row as { platform_publish_intent: Record<string, unknown> | null })
        .platform_publish_intent ?? null;

    // Source the current creative from the publish request — that's
    // the exact creative the publisher will attach, so the hash we
    // compare matches what the publisher would persist.
    const creative = request.creative
      ? {
          assetUrl: request.creative.assetUrl,
          sourceUrl: request.creative.sourceUrl,
          altText: request.creative.altText,
          creativeType: request.creative.creativeType,
        }
      : null;

    return await decideBlueskyPublishGate({
      rawIntent,
      title: (row as { title: string | null }).title,
      body: (row as { body: string | null }).body ?? request.body ?? "",
      creative,
    });
  } catch (err) {
    console.error(
      "[bluesky-orch] shape-binding gate load failed; proceeding",
      err,
    );
    return { kind: "proceed", payloadHash: null };
  }
}
