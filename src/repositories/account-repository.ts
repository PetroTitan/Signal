import "server-only";
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
  role: string | null;
  status: string;
  connectionStatus: string;
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
    status: row.status,
    connectionStatus: row.connection_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAccounts(
  workspaceId: string,
): Promise<GrowthAccountRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("growth_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list accounts.");
  return ((data ?? []) as unknown as GrowthAccountRow[]).map(toAccount);
}

export async function getAccountById(
  workspaceId: string,
  accountId: string,
): Promise<GrowthAccountRecord> {
  const supabase = createSupabaseServerClient();
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
  role?: string | null;
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
  role?: string | null;
  status?: string;
  productId?: string | null;
}): Promise<GrowthAccountRecord> {
  const supabase = createSupabaseServerClient();
  const patch: GrowthAccountUpdate = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.handle !== undefined) patch.handle = input.handle;
  if (input.role !== undefined) patch.role = input.role;
  if (input.status !== undefined) patch.status = input.status;
  if (input.productId !== undefined) patch.product_id = input.productId;

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
