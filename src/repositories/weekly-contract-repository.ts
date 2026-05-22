import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WeeklyApprovalContractInsert,
  WeeklyApprovalContractRow,
  WeeklyApprovalContractUpdate,
  WeeklyContractAccountInsert,
  WeeklyContractAccountRow,
  WeeklyContractAllowedActionInsert,
  WeeklyContractAllowedActionRow,
  WeeklyContractExecutionWindowInsert,
  WeeklyContractExecutionWindowRow,
  WeeklyContractPlatformInsert,
  WeeklyContractPlatformRow,
  WeeklyContractProductInsert,
  WeeklyContractProductRow,
} from "@/lib/supabase/types";
import {
  assertTransition,
  type ExecutionWindowDef,
  type WeeklyContract,
  type WeeklyContractActionType,
  type WeeklyContractRiskCeiling,
  type WeeklyContractStatus,
} from "@/core/weekly-contract";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

function toContractBase(
  row: WeeklyApprovalContractRow,
): Omit<WeeklyContract, "scope"> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    title: row.title,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    status: row.status,
    maxRiskLevel: row.max_risk_level,
    maxActionsTotal: row.max_actions_total,
    maxActionsPerDay: row.max_actions_per_day,
    maxActionsPerPlatformPerDay: row.max_actions_per_platform_per_day,
    pauseOnFirstFailure: row.pause_on_first_failure,
    pauseOnRiskEvent: row.pause_on_risk_event,
    notes: row.notes,
    approvalTextPhrase: row.approval_text_phrase,
    approvedAt: row.approved_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    expiredAt: row.expired_at,
    revokedAt: row.revoked_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWindow(row: WeeklyContractExecutionWindowRow): ExecutionWindowDef {
  return {
    id: row.id,
    dayOfWeek: row.day_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

async function loadContractScope(
  workspaceId: string,
  contractId: string,
): Promise<WeeklyContract["scope"]> {
  const supabase = createSupabaseServerClient();
  const [accounts, products, platforms, actions, windows] = await Promise.all([
    supabase
      .from("weekly_contract_accounts")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_products")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_platforms")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_allowed_actions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_execution_windows")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true }),
  ]);
  if (accounts.error) throw fromPostgres(accounts.error, "Failed to load contract accounts.");
  if (products.error) throw fromPostgres(products.error, "Failed to load contract products.");
  if (platforms.error) throw fromPostgres(platforms.error, "Failed to load contract platforms.");
  if (actions.error) throw fromPostgres(actions.error, "Failed to load contract actions.");
  if (windows.error) throw fromPostgres(windows.error, "Failed to load contract windows.");

  return {
    accountIds: ((accounts.data ?? []) as unknown as WeeklyContractAccountRow[]).map(
      (r) => r.account_id,
    ),
    productIds: ((products.data ?? []) as unknown as WeeklyContractProductRow[]).map(
      (r) => r.product_id,
    ),
    platforms: ((platforms.data ?? []) as unknown as WeeklyContractPlatformRow[]).map(
      (r) => r.platform,
    ),
    allowedActions: (
      (actions.data ?? []) as unknown as WeeklyContractAllowedActionRow[]
    ).map((r) => r.action_type),
    executionWindows: (
      (windows.data ?? []) as unknown as WeeklyContractExecutionWindowRow[]
    ).map(toWindow),
  };
}

// =====================================================================
// Reads
// =====================================================================

export async function listWeeklyContracts(
  workspaceId: string,
  limit = 20,
): Promise<WeeklyContract[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("week_start", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list weekly contracts.");
  const rows = (data ?? []) as unknown as WeeklyApprovalContractRow[];
  const scopes = await Promise.all(
    rows.map((r) => loadContractScope(workspaceId, r.id)),
  );
  return rows.map((row, i) => ({ ...toContractBase(row), scope: scopes[i]! }));
}

export async function getActiveContract(
  workspaceId: string,
): Promise<WeeklyContract | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load active weekly contract.");
  if (!data) return null;
  const row = data as unknown as WeeklyApprovalContractRow;
  const scope = await loadContractScope(workspaceId, row.id);
  return { ...toContractBase(row), scope };
}

export async function getWeeklyContractById(
  workspaceId: string,
  contractId: string,
): Promise<WeeklyContract> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load weekly contract.");
  if (!data) throw notFound("Weekly contract");
  const row = data as unknown as WeeklyApprovalContractRow;
  const scope = await loadContractScope(workspaceId, row.id);
  return { ...toContractBase(row), scope };
}

// =====================================================================
// Writes
// =====================================================================

export interface CreateWeeklyContractInput {
  workspaceId: string;
  title: string;
  weekStart: string;
  weekEnd: string;
  maxRiskLevel?: WeeklyContractRiskCeiling;
  maxActionsTotal?: number | null;
  maxActionsPerDay?: number | null;
  maxActionsPerPlatformPerDay?: number | null;
  pauseOnFirstFailure?: boolean;
  pauseOnRiskEvent?: boolean;
  notes?: string | null;
  accountIds: string[];
  productIds: string[];
  platforms: string[];
  allowedActions: WeeklyContractActionType[];
  executionWindows: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>;
}

export async function createWeeklyContract(
  input: CreateWeeklyContractInput,
): Promise<WeeklyContract> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const insert: WeeklyApprovalContractInsert = {
    workspace_id: input.workspaceId,
    created_by: user.id,
    title: input.title,
    week_start: input.weekStart,
    week_end: input.weekEnd,
    status: "draft",
    max_risk_level: input.maxRiskLevel ?? "medium",
    max_actions_total: input.maxActionsTotal ?? null,
    max_actions_per_day: input.maxActionsPerDay ?? null,
    max_actions_per_platform_per_day: input.maxActionsPerPlatformPerDay ?? null,
    pause_on_first_failure: input.pauseOnFirstFailure ?? true,
    pause_on_risk_event: input.pauseOnRiskEvent ?? true,
    notes: input.notes ?? null,
  };
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create weekly contract.");
  const row = data as unknown as WeeklyApprovalContractRow;
  await replaceContractScope(input.workspaceId, row.id, {
    accountIds: input.accountIds,
    productIds: input.productIds,
    platforms: input.platforms,
    allowedActions: input.allowedActions,
    executionWindows: input.executionWindows,
  });
  return getWeeklyContractById(input.workspaceId, row.id);
}

export interface ReplaceContractScopeInput {
  accountIds: string[];
  productIds: string[];
  platforms: string[];
  allowedActions: WeeklyContractActionType[];
  executionWindows: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>;
}

export async function replaceContractScope(
  workspaceId: string,
  contractId: string,
  scope: ReplaceContractScopeInput,
): Promise<void> {
  const supabase = createSupabaseServerClient();

  // Delete existing scope rows first; PK constraints prevent dupes
  // anyway, but a clean replace keeps the UI simple.
  const deletes = await Promise.all([
    supabase
      .from("weekly_contract_accounts")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_products")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_platforms")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_allowed_actions")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
    supabase
      .from("weekly_contract_execution_windows")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("contract_id", contractId),
  ]);
  for (const r of deletes) {
    if (r.error) throw fromPostgres(r.error, "Failed to clear contract scope.");
  }

  if (scope.accountIds.length > 0) {
    const rows: WeeklyContractAccountInsert[] = scope.accountIds.map((id) => ({
      contract_id: contractId,
      workspace_id: workspaceId,
      account_id: id,
    }));
    const { error } = await supabase
      .from("weekly_contract_accounts")
      .insert(rows as never);
    if (error) throw fromPostgres(error, "Failed to insert contract accounts.");
  }
  if (scope.productIds.length > 0) {
    const rows: WeeklyContractProductInsert[] = scope.productIds.map((id) => ({
      contract_id: contractId,
      workspace_id: workspaceId,
      product_id: id,
    }));
    const { error } = await supabase
      .from("weekly_contract_products")
      .insert(rows as never);
    if (error) throw fromPostgres(error, "Failed to insert contract products.");
  }
  if (scope.platforms.length > 0) {
    const rows: WeeklyContractPlatformInsert[] = scope.platforms.map((p) => ({
      contract_id: contractId,
      workspace_id: workspaceId,
      platform: p,
    }));
    const { error } = await supabase
      .from("weekly_contract_platforms")
      .insert(rows as never);
    if (error) throw fromPostgres(error, "Failed to insert contract platforms.");
  }
  if (scope.allowedActions.length > 0) {
    const rows: WeeklyContractAllowedActionInsert[] = scope.allowedActions.map(
      (a) => ({ contract_id: contractId, workspace_id: workspaceId, action_type: a }),
    );
    const { error } = await supabase
      .from("weekly_contract_allowed_actions")
      .insert(rows as never);
    if (error) throw fromPostgres(error, "Failed to insert contract actions.");
  }
  if (scope.executionWindows.length > 0) {
    const rows: WeeklyContractExecutionWindowInsert[] = scope.executionWindows.map(
      (w) => ({
        contract_id: contractId,
        workspace_id: workspaceId,
        day_of_week: w.dayOfWeek,
        start_time: w.startTime,
        end_time: w.endTime,
      }),
    );
    const { error } = await supabase
      .from("weekly_contract_execution_windows")
      .insert(rows as never);
    if (error) throw fromPostgres(error, "Failed to insert execution windows.");
  }
}

async function updateContractStatus(
  workspaceId: string,
  contractId: string,
  next: WeeklyContractStatus,
  patch: WeeklyApprovalContractUpdate,
): Promise<WeeklyContract> {
  const supabase = createSupabaseServerClient();
  const current = await getWeeklyContractById(workspaceId, contractId);
  assertTransition(current.status, next);

  const { error } = await supabase
    .from("weekly_approval_contracts")
    .update({ ...patch, status: next } as never)
    .eq("workspace_id", workspaceId)
    .eq("id", contractId);
  if (error) throw fromPostgres(error, "Failed to update contract status.");
  return getWeeklyContractById(workspaceId, contractId);
}

export async function submitContractForApproval(
  workspaceId: string,
  contractId: string,
): Promise<WeeklyContract> {
  return updateContractStatus(workspaceId, contractId, "pending_approval", {});
}

export async function approveContract(input: {
  workspaceId: string;
  contractId: string;
  approvalTextPhrase: string;
}): Promise<WeeklyContract> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();
  return updateContractStatus(input.workspaceId, input.contractId, "approved", {
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    approval_text_phrase: input.approvalTextPhrase,
  });
}

export async function activateContract(
  workspaceId: string,
  contractId: string,
): Promise<WeeklyContract> {
  // Expire any currently-active contract first to satisfy the
  // "one active per workspace" unique partial index.
  const supabase = createSupabaseServerClient();
  const { data: actives, error: listError } = await supabase
    .from("weekly_approval_contracts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (listError) throw fromPostgres(listError, "Failed to list active contracts.");
  for (const a of (actives ?? []) as Array<{ id: string }>) {
    if (a.id === contractId) continue;
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("weekly_approval_contracts")
      .update({ status: "expired", expired_at: nowIso } as never)
      .eq("workspace_id", workspaceId)
      .eq("id", a.id);
    if (error) throw fromPostgres(error, "Failed to expire prior contract.");
  }
  return updateContractStatus(workspaceId, contractId, "active", {
    activated_at: new Date().toISOString(),
  });
}

export async function pauseContract(input: {
  workspaceId: string;
  contractId: string;
  reason?: string;
}): Promise<WeeklyContract> {
  return updateContractStatus(input.workspaceId, input.contractId, "paused", {
    paused_at: new Date().toISOString(),
    metadata: input.reason ? { pause_reason: input.reason } : undefined,
  });
}

export async function resumeContract(
  workspaceId: string,
  contractId: string,
): Promise<WeeklyContract> {
  return updateContractStatus(workspaceId, contractId, "active", {
    paused_at: null,
  });
}

export async function revokeContract(input: {
  workspaceId: string;
  contractId: string;
  reason?: string;
}): Promise<WeeklyContract> {
  return updateContractStatus(input.workspaceId, input.contractId, "revoked", {
    revoked_at: new Date().toISOString(),
    metadata: input.reason ? { revoke_reason: input.reason } : undefined,
  });
}
