import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  GrowthAccountInsert,
  GrowthAccountRow,
  GrowthAccountUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

export interface GrowthAccountRecord {
  id: string;
  workspaceId: string;
  productId: string | null;
  platform: string;
  handle: string | null;
  displayName: string | null;
  /**
   * Legacy column. Founder UI no longer sets it; kept for backward
   * compatibility while older rows still carry "founder" / "team" / etc.
   * @deprecated read `voiceProfile` instead.
   */
  role: string | null;
  /**
   * F4.4 — free-form description of how this publishing identity
   * writes. Single source of truth for AI/MCP generation context.
   */
  voiceProfile: string | null;
  status: string;
  connectionStatus: string;
  source: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
}

function toAccount(row: GrowthAccountRow): GrowthAccountRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    platform: row.platform,
    handle: row.handle,
    displayName: row.display_name,
    role: row.role,
    voiceProfile: row.voice_profile,
    status: row.status,
    connectionStatus: row.connection_status,
    source: row.source,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List active (non-archived) accounts for the workspace. Pass
 * `includeArchived: true` to get everything.
 */
export async function listAccounts(
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Promise<GrowthAccountRecord[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("growth_accounts")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (!options.includeArchived) {
    query = query.neq("status", "archived");
  }
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list accounts.");
  return ((data ?? []) as unknown as GrowthAccountRow[]).map(toAccount);
}

/**
 * List active accounts for a single platform. Used by the platform
 * command-center pages.
 */
export async function listAccountsByPlatform(
  workspaceId: string,
  platform: string,
): Promise<GrowthAccountRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("growth_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("platform", platform)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list accounts.");
  return ((data ?? []) as unknown as GrowthAccountRow[]).map(toAccount);
}

export async function archiveAccount(input: {
  workspaceId: string;
  accountId: string;
}): Promise<GrowthAccountRecord> {
  return updateAccount({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    status: "archived",
  });
}

export async function getAccountById(
  workspaceId: string,
  accountId: string,
  /**
   * Optional injected client. UI / server-action callers omit it and
   * pick up the cookie-aware client by default. The MCP layer passes
   * its service-role client (ctx.db) so requests outside the cookie
   * session (operator-token bearer auth on /api/mcp) can still read
   * workspace rows.
   */
  db?: SupabaseClient,
): Promise<GrowthAccountRecord> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("growth_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load account.");
  if (!data) throw notFound("Account");
  return toAccount(data as unknown as GrowthAccountRow);
}

export interface AccountInput {
  workspaceId: string;
  platform: string;
  displayName: string;
  handle?: string | null;
  /** @deprecated kept for backward compat; founder UI sets voiceProfile instead. */
  role?: string | null;
  voiceProfile?: string | null;
  productId?: string | null;
}

export async function createAccount(
  input: AccountInput,
): Promise<GrowthAccountRecord> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const insert: GrowthAccountInsert = {
    workspace_id: input.workspaceId,
    product_id: input.productId ?? null,
    platform: input.platform,
    handle: input.handle ?? null,
    display_name: input.displayName,
    role: input.role ?? null,
    voice_profile: input.voiceProfile ?? null,
    status: "planned",
    connection_status: "not_connected",
  };
  const { data, error } = await supabase
    .from("growth_accounts")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create account.");
  return toAccount(data as unknown as GrowthAccountRow);
}

export async function updateAccount(input: {
  workspaceId: string;
  accountId: string;
  displayName?: string;
  handle?: string | null;
  /** @deprecated kept for backward compat; set voiceProfile instead. */
  role?: string | null;
  voiceProfile?: string | null;
  status?: string;
  productId?: string | null;
  reviewStatus?: "pending_review" | "confirmed" | "rejected" | "needs_edit";
}): Promise<GrowthAccountRecord> {
  const supabase = createSupabaseServerClient();
  const patch: GrowthAccountUpdate = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.handle !== undefined) patch.handle = input.handle;
  if (input.role !== undefined) patch.role = input.role;
  if (input.voiceProfile !== undefined) patch.voice_profile = input.voiceProfile;
  if (input.status !== undefined) patch.status = input.status;
  if (input.productId !== undefined) patch.product_id = input.productId;
  if (input.reviewStatus !== undefined) patch.review_status = input.reviewStatus;

  const { data, error } = await supabase
    .from("growth_accounts")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.accountId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update account.");
  return toAccount(data as unknown as GrowthAccountRow);
}

/**
 * Phase F2 — mirror the platform_connections.connection_status onto
 * growth_accounts. Called by the OAuth callback / disconnect routes
 * so the /accounts list reflects the live connection state.
 */
export async function setAccountConnectionStatus(input: {
  workspaceId: string;
  accountId: string;
  connectionStatus:
    | "not_connected"
    | "connected"
    | "expired"
    | "revoked"
    | "reauthorization_required"
    | "error";
}): Promise<GrowthAccountRecord> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("growth_accounts")
    .update({ connection_status: input.connectionStatus } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.accountId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to update account connection status.");
  return toAccount(data as unknown as GrowthAccountRow);
}

/**
 * Accounts waiting for operator review (the approval-queue feed).
 * Excludes archived rows; sorted oldest-first.
 */
export async function listAccountsPendingReview(
  workspaceId: string,
): Promise<GrowthAccountRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("growth_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("review_status", "pending_review")
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error)
    throw fromPostgres(error, "Failed to list accounts pending review.");
  return ((data ?? []) as unknown as GrowthAccountRow[]).map(toAccount);
}

export async function approveAccountReview(input: {
  workspaceId: string;
  accountId: string;
}): Promise<GrowthAccountRecord> {
  return updateAccount({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    reviewStatus: "confirmed",
  });
}

export async function rejectAccountReview(input: {
  workspaceId: string;
  accountId: string;
}): Promise<GrowthAccountRecord> {
  return updateAccount({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    reviewStatus: "rejected",
  });
}
