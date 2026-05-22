import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  OAuthStateTokenInsert,
  OAuthStateTokenRow,
  PlatformConnectionInsert,
  PlatformConnectionRow,
  PlatformConnectionUpdate,
} from "@/lib/supabase/types";
import type {
  OAuthPlatform,
  PlatformConnection,
  PlatformConnectionConnectionStatus,
} from "@/core/platform-oauth";
import { fromPostgres, notFound } from "./errors";

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
): Promise<PlatformConnection> {
  const supabase = createSupabaseServerClient();
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
): Promise<PlatformConnection | null> {
  const supabase = createSupabaseServerClient();
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
  platform: OAuthPlatform;
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
): Promise<PlatformConnection> {
  const supabase = createSupabaseServerClient();
  const nowIso = new Date().toISOString();

  // Find existing row keyed by (workspace, account, platform) or
  // (workspace, platform, provider_account_id).
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
  if (!existingId && input.providerAccountId) {
    const { data } = await supabase
      .from("platform_connections")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("platform", input.platform)
      .eq("provider_account_id", input.providerAccountId)
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
    return getPlatformConnectionById(input.workspaceId, existingId);
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
  if (error || !data)
    throw fromPostgres(error, "Failed to insert platform connection.");
  return toConnection(data as unknown as PlatformConnectionRow);
}

export async function markConnectionStatus(input: {
  workspaceId: string;
  connectionId: string;
  status: PlatformConnectionConnectionStatus;
  healthStatus?: PlatformConnection["healthStatus"];
  message?: string;
}): Promise<PlatformConnection> {
  const supabase = createSupabaseServerClient();
  const patch: PlatformConnectionUpdate = {
    connection_status: input.status,
    last_checked_at: new Date().toISOString(),
    health_status: input.healthStatus ?? "unknown",
    revoked_at: input.status === "revoked" ? new Date().toISOString() : null,
    metadata: input.message ? { last_message: input.message } : undefined,
  };
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
  return getPlatformConnectionById(input.workspaceId, input.connectionId);
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
