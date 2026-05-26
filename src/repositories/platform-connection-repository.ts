import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  OAuthStateTokenInsert,
  OAuthStateTokenRow,
  PlatformConnectionInsert,
  PlatformConnectionRow,
  PlatformConnectionUpdate,
} from "@/lib/supabase/types";
import type {
  ConnectionPlatform,
  OAuthPlatform,
  PlatformConnection,
  PlatformConnectionConnectionStatus,
} from "@/core/platform-oauth";
import { fromPostgres, notFound } from "./errors";

/**
 * Thrown by `upsertPlatformConnection` when the insert path would
 * have rebound an existing `(workspace_id, platform, provider_account_id)`
 * row onto a DIFFERENT `account_id`.
 *
 * Decision (per-identity invariant): we do NOT rebind one
 * `platform_connections` row across identities. If an operator pastes
 * a credential that resolves to a provider account already attached
 * to a sibling identity in the same workspace, we refuse the insert
 * and surface a closed-list error to the connect route. The operator
 * is told which identity already owns it and routed to the existing
 * Manage panel instead of silently moving the row.
 */
export class PlatformConnectionAttachedToAnotherIdentityError extends Error {
  readonly code = "attached_to_another_identity" as const;
  constructor(message?: string) {
    super(message ?? "Provider account already attached to another identity.");
    this.name = "PlatformConnectionAttachedToAnotherIdentityError";
  }
}

/**
 * Domain projection. The repository is the *only* place that ever
 * sees the encrypted-token columns; the client receives the
 * `hasAccessToken` / `hasRefreshToken` booleans instead.
 */
function toConnection(row: PlatformConnectionRow): PlatformConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    platform: row.platform,
    providerAccountId: row.provider_account_id,
    handle: row.handle,
    displayName: row.display_name,
    connectionStatus: row.connection_status,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    connectedAt: row.connected_at,
    revokedAt: row.revoked_at,
    lastCheckedAt: row.last_checked_at,
    healthStatus: row.health_status,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasAccessToken: row.access_token_encrypted !== null,
    hasRefreshToken: row.refresh_token_encrypted !== null,
  };
}

// =====================================================================
// Reads
// =====================================================================

export async function listPlatformConnections(
  workspaceId: string,
): Promise<PlatformConnection[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("platform_connections")
    .select(
      "id, workspace_id, account_id, platform, provider_account_id, handle, display_name, connection_status, scopes, expires_at, connected_at, revoked_at, last_checked_at, health_status, metadata, created_at, updated_at, access_token_encrypted, refresh_token_encrypted",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw fromPostgres(error, "Failed to list platform connections.");
  return ((data ?? []) as unknown as PlatformConnectionRow[]).map(toConnection);
}

export async function getPlatformConnectionById(
  workspaceId: string,
  connectionId: string,
  /**
   * Optional injected client. UI / server-action callers omit it and
   * use the cookie-aware client. The Bluesky orchestrator passes its
   * service-role client through under cron-triggered ticks so the
   * read-back after upsert / markConnectionStatus is not blocked by
   * RLS. Same additive pattern as getAccountById.
   */
  db?: SupabaseClient,
): Promise<PlatformConnection> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("platform_connections")
    .select(
      "id, workspace_id, account_id, platform, provider_account_id, handle, display_name, connection_status, scopes, expires_at, connected_at, revoked_at, last_checked_at, health_status, metadata, created_at, updated_at, access_token_encrypted, refresh_token_encrypted",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load platform connection.");
  if (!data) throw notFound("Platform connection");
  return toConnection(data as unknown as PlatformConnectionRow);
}

export async function getConnectionForAccount(
  workspaceId: string,
  accountId: string,
  platform: OAuthPlatform,
  /**
   * Optional injected client. UI / server-action callers omit it and
   * pick up the cookie-aware client by default. The scheduler tick
   * passes its service-role client so the read is not blocked by RLS
   * in a runtime without an operator cookie. Same additive pattern
   * as getAccountById.
   */
  db?: SupabaseClient,
): Promise<PlatformConnection | null> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("platform_connections")
    .select(
      "id, workspace_id, account_id, platform, provider_account_id, handle, display_name, connection_status, scopes, expires_at, connected_at, revoked_at, last_checked_at, health_status, metadata, created_at, updated_at, access_token_encrypted, refresh_token_encrypted",
    )
    .eq("workspace_id", workspaceId)
    .eq("account_id", accountId)
    .eq("platform", platform)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load platform connection.");
  if (!data) return null;
  return toConnection(data as unknown as PlatformConnectionRow);
}

// =====================================================================
// Writes
// =====================================================================

export interface UpsertConnectionInput {
  workspaceId: string;
  accountId: string | null;
  /**
   * Widened from `OAuthPlatform` to `ConnectionPlatform` so the
   * api_key_verify path (Bluesky today; dev.to / Hashnode / Telegram
   * in follow-ups) can persist per-identity rows through the same
   * repository function. OAuth callers still pass `OAuthPlatform`
   * values, which are a subset of `ConnectionPlatform` — no change
   * required.
   */
  platform: ConnectionPlatform;
  providerAccountId: string | null;
  handle: string | null;
  displayName: string | null;
  scopes: string[];
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  expiresAt: string | null;
  connectionStatus: PlatformConnectionConnectionStatus;
  metadata?: Record<string, unknown>;
}

export async function upsertPlatformConnection(
  input: UpsertConnectionInput,
  /**
   * Optional injected client. UI / OAuth-callback callers omit it
   * and use the cookie-aware client. The Bluesky orchestrator passes
   * its service-role client through when the refresh path runs under
   * a cron-triggered tick (no operator cookie). Same additive pattern
   * as getAccountById.
   */
  db?: SupabaseClient,
): Promise<PlatformConnection> {
  const supabase = db ?? createSupabaseServerClient();
  const nowIso = new Date().toISOString();

  // Strict per-identity lookup. The row is keyed only by
  // (workspace_id, account_id, platform). We deliberately do NOT
  // fall back to a (workspace_id, platform, provider_account_id)
  // lookup — that would let two identities share or rebind one row,
  // which is the cross-identity reuse the product contract refuses.
  //
  // If accountId is null (some OAuth-callback error paths land here
  // before the state row has bound an identity), we always insert a
  // fresh row.
  let existingId: string | null = null;
  if (input.accountId) {
    const { data } = await supabase
      .from("platform_connections")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("account_id", input.accountId)
      .eq("platform", input.platform)
      .maybeSingle();
    if (data) existingId = (data as { id: string }).id;
  }

  if (existingId) {
    const patch: PlatformConnectionUpdate = {
      account_id: input.accountId,
      provider_account_id: input.providerAccountId,
      handle: input.handle,
      display_name: input.displayName,
      scopes: input.scopes,
      access_token_encrypted: input.accessTokenEncrypted,
      refresh_token_encrypted: input.refreshTokenEncrypted,
      expires_at: input.expiresAt,
      connection_status: input.connectionStatus,
      connected_at: input.connectionStatus === "connected" ? nowIso : undefined,
      revoked_at: input.connectionStatus === "revoked" ? nowIso : null,
      last_checked_at: nowIso,
      health_status:
        input.connectionStatus === "connected"
          ? "healthy"
          : input.connectionStatus === "revoked"
          ? "revoked"
          : input.connectionStatus === "expired"
          ? "expired"
          : "unknown",
      metadata: input.metadata,
    };
    const { error } = await supabase
      .from("platform_connections")
      .update(patch as never)
      .eq("workspace_id", input.workspaceId)
      .eq("id", existingId);
    if (error) throw fromPostgres(error, "Failed to update platform connection.");
    return getPlatformConnectionById(input.workspaceId, existingId, db);
  }

  const insert: PlatformConnectionInsert = {
    workspace_id: input.workspaceId,
    account_id: input.accountId,
    platform: input.platform,
    provider_account_id: input.providerAccountId,
    handle: input.handle,
    display_name: input.displayName,
    scopes: input.scopes,
    access_token_encrypted: input.accessTokenEncrypted,
    refresh_token_encrypted: input.refreshTokenEncrypted,
    expires_at: input.expiresAt,
    connection_status: input.connectionStatus,
    connected_at: input.connectionStatus === "connected" ? nowIso : null,
    last_checked_at: nowIso,
    health_status:
      input.connectionStatus === "connected" ? "healthy" : "unknown",
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("platform_connections")
    .insert(insert as never)
    .select(
      "id, workspace_id, account_id, platform, provider_account_id, handle, display_name, connection_status, scopes, expires_at, connected_at, revoked_at, last_checked_at, health_status, metadata, created_at, updated_at, access_token_encrypted, refresh_token_encrypted",
    )
    .single();
  if (error || !data) {
    // 23505 = Postgres unique-violation. Two indexes can trigger it
    // on this table:
    //   - platform_connections_unique_per_account
    //     (workspace_id, account_id, platform) — would only fire on a
    //     race where the upsert lookup above missed a concurrent
    //     insert; surface generically.
    //   - platform_connections_unique_provider
    //     (workspace_id, platform, provider_account_id) — fires when
    //     an operator tries to attach a credential that resolves to a
    //     provider account already bound to a sibling identity in the
    //     same workspace. That's the per-identity invariant; we want
    //     the connect route to surface "attached_to_another_identity"
    //     rather than a generic 500.
    if (error?.code === "23505") {
      throw new PlatformConnectionAttachedToAnotherIdentityError(
        "Provider account already attached to another identity in this workspace.",
      );
    }
    throw fromPostgres(error, "Failed to insert platform connection.");
  }
  return toConnection(data as unknown as PlatformConnectionRow);
}

/**
 * Phase F2 — server-only token read. Returns the raw encrypted
 * envelopes for a connection. The caller MUST decrypt server-side
 * via `decryptForOutboundUse` and discard the plaintext after the
 * outbound call. Never return these values to client-facing code.
 */
export async function readEncryptedTokens(
  workspaceId: string,
  connectionId: string,
  /**
   * Optional injected client. UI / server-action callers omit it
   * and use the cookie-aware client. The Bluesky orchestrator passes
   * its service-role client through under cron-triggered ticks so
   * the encrypted-token read isn't hidden by RLS. Same additive
   * pattern as getAccountById.
   */
  db?: SupabaseClient,
): Promise<{
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  expiresAt: string | null;
} | null> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("platform_connections")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at")
    .eq("workspace_id", workspaceId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to read encrypted tokens.");
  if (!data) return null;
  const row = data as unknown as {
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
    expires_at: string | null;
  };
  return {
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    expiresAt: row.expires_at,
  };
}

/**
 * Phase F2 — refresh-token rotation. Replaces the encrypted access
 * token + expiry on an existing connection. Used by the
 * refresh-on-401 path so the scheduler can re-attempt the publish
 * without flipping the row to `reauthorization_required`.
 */
export async function rotateAccessToken(input: {
  workspaceId: string;
  connectionId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiresAt: string | null;
  scopes: string[];
}): Promise<PlatformConnection> {
  const supabase = createSupabaseServerClient();
  const patch: PlatformConnectionUpdate = {
    access_token_encrypted: input.accessTokenEncrypted,
    refresh_token_encrypted: input.refreshTokenEncrypted,
    expires_at: input.expiresAt,
    scopes: input.scopes,
    last_checked_at: new Date().toISOString(),
    connection_status: "connected",
    health_status: "healthy",
  };
  const { error } = await supabase
    .from("platform_connections")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.connectionId);
  if (error) throw fromPostgres(error, "Failed to rotate access token.");
  return getPlatformConnectionById(input.workspaceId, input.connectionId);
}

export async function markConnectionStatus(
  input: {
    workspaceId: string;
    connectionId: string;
    status: PlatformConnectionConnectionStatus;
    healthStatus?: PlatformConnection["healthStatus"];
    message?: string;
    /**
     * Metadata keys to explicitly remove from the connection. Used by
     * the disconnect path to drop `handle_mismatch` so an identity
     * doesn't stay stuck in 'mismatched' after the operator has
     * explicitly disconnected it.
     *
     * Triggers a read-modify-write so the rest of the metadata
     * (e.g. token_storage diagnostics) is preserved. When omitted, the
     * function keeps its original wholesale-replace behaviour for
     * backwards compatibility with the health-check callers.
     */
    clearMetadataKeys?: ReadonlyArray<string>;
  },
  /**
   * Optional injected client. Health-check / disconnect UI callers
   * omit it and use the cookie-aware client. The Bluesky orchestrator
   * passes its service-role client through when marking an expired /
   * mismatched session under a cron-triggered tick. Same additive
   * pattern as getAccountById.
   */
  db?: SupabaseClient,
): Promise<PlatformConnection> {
  const supabase = db ?? createSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const patch: PlatformConnectionUpdate = {
    connection_status: input.status,
    last_checked_at: nowIso,
    health_status: input.healthStatus ?? "unknown",
    revoked_at: input.status === "revoked" ? nowIso : null,
  };

  if (input.clearMetadataKeys && input.clearMetadataKeys.length > 0) {
    // Read-modify-write path: preserve existing metadata, drop the
    // listed keys, and layer last_message on top if provided.
    const existing = await getPlatformConnectionById(
      input.workspaceId,
      input.connectionId,
      db,
    );
    const merged: Record<string, unknown> = { ...existing.metadata };
    for (const key of input.clearMetadataKeys) {
      delete merged[key];
    }
    if (input.message) merged.last_message = input.message;
    patch.metadata = merged;
  } else if (input.message) {
    // Backwards-compatible wholesale-replace path for callers that
    // didn't opt into selective clearing.
    patch.metadata = { last_message: input.message };
  }

  // When revoking, clear the encrypted tokens too.
  if (input.status === "revoked") {
    patch.access_token_encrypted = null;
    patch.refresh_token_encrypted = null;
  }
  const { error } = await supabase
    .from("platform_connections")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.connectionId);
  if (error) throw fromPostgres(error, "Failed to update connection status.");
  return getPlatformConnectionById(input.workspaceId, input.connectionId, db);
}

// =====================================================================
// OAuth state-token bookkeeping
// =====================================================================

export async function persistOAuthState(input: {
  state: string;
  workspaceId: string;
  userId: string;
  platform: OAuthPlatform;
  accountId?: string | null;
  redirectAfter?: string | null;
  codeVerifier?: string | null;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const insert: OAuthStateTokenInsert = {
    state: input.state,
    workspace_id: input.workspaceId,
    user_id: input.userId,
    platform: input.platform,
    account_id: input.accountId ?? null,
    redirect_after: input.redirectAfter ?? null,
    code_verifier: input.codeVerifier ?? null,
  };
  const { error } = await supabase
    .from("oauth_state_tokens")
    .insert(insert as never);
  if (error) throw fromPostgres(error, "Failed to persist OAuth state.");
}

export async function consumeOAuthState(
  state: string,
): Promise<OAuthStateTokenRow | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("oauth_state_tokens")
    .select("*")
    .eq("state", state)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load OAuth state.");
  if (!data) return null;
  // One-shot: delete on read so the state cannot be replayed.
  await supabase.from("oauth_state_tokens").delete().eq("state", state);
  return data as unknown as OAuthStateTokenRow;
}
