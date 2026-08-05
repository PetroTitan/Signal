import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  type WeeklyContractScope,
  type WeeklyContractStatus,
} from "@/core/weekly-contract";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

/**
 * Resolve the Supabase client for a repository call.
 *
 * Callers running inside a request (server components, server
 * actions) omit `db` and get the cookie-bound client. Callers running
 * outside a request context — notably the MCP tool dispatcher, which
 * holds a service-role client — pass their own.
 *
 * `??` short-circuits, so `createSupabaseServerClient()` is never
 * invoked when an injected client is supplied. That is the property
 * the MCP path depends on: no cookie-aware client is constructed
 * there.
 */
function resolveDb(db?: SupabaseClient): SupabaseClient {
  return db ?? (createSupabaseServerClient() as unknown as SupabaseClient);
}

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
  db?: SupabaseClient,
): Promise<WeeklyContract["scope"]> {
  const supabase = resolveDb(db);
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
// Active-authorization evaluation
//
// One canonical answer to "may this item be scheduled?", used by any
// caller that must enforce an operator's approval envelope.
//
// Design rules this section encodes:
//
//   - Contract-free per-item scheduling is DELIBERATE (see migration
//     20260605000001_contract_free_per_post_publishing.sql). It stays
//     allowed when NO active authorization governs the workspace.
//   - Once an active authorization exists, its scope is an explicit
//     operator boundary: out-of-scope items are REFUSED, never
//     silently downgraded to the contract-free path.
//   - Expiry is enforced at READ time. Correctness must not depend on
//     a cron or background writer having run.
//   - A load failure is never "no contract". It throws, and the caller
//     turns it into a refusal.
// =====================================================================

/**
 * Which load failed. Callers map this to distinct refusal codes so a
 * schema/permission fault on the contract row is distinguishable from
 * one on the scope join tables.
 */
export type ActiveAuthorizationLoadStage = "contract" | "scope";

export class ActiveAuthorizationLoadError extends Error {
  readonly stage: ActiveAuthorizationLoadStage;
  readonly reason: unknown;

  constructor(stage: ActiveAuthorizationLoadStage, reason: unknown) {
    const detail =
      reason instanceof Error ? reason.message : String(reason ?? "unknown");
    super(`Failed to load active authorization (${stage}): ${detail}`);
    this.name = "ActiveAuthorizationLoadError";
    this.stage = stage;
    this.reason = reason;
  }
}

export type ActiveAuthorizationResolution =
  /** No active authorization governs this workspace. */
  | { outcome: "none" }
  /** An active, in-date authorization. Its scope must still be checked. */
  | { outcome: "active"; contract: WeeklyContract }
  /** Row says `active` but its window has closed. Must not authorize. */
  | { outcome: "expired"; contract: WeeklyContract }
  /** Row says `active` but its end boundary is unparseable. Fail closed. */
  | { outcome: "malformed_boundary"; contract: WeeklyContract };

/**
 * Exclusive end of an authorization window, in epoch ms.
 *
 * `week_end` is a DATE (`YYYY-MM-DD`) with no timezone, and it is
 * inclusive — an authorization "ending 2026-05-31" covers all of the
 * 31st. The boundary is therefore midnight UTC at the START of the
 * following day, and the window is closed once `now >= boundary`.
 *
 * Returns null when the value is not a well-formed calendar date, so
 * the caller can fail closed instead of guessing.
 */
export function authorizationWindowEndExclusiveMs(
  weekEnd: string,
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekEnd.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const startOfEndDay = Date.UTC(year, month - 1, day);
  const parsed = new Date(startOfEndDay);
  // Reject impossible dates that Date.UTC would silently roll over
  // (e.g. 2026-02-30 becoming March 2nd).
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return startOfEndDay + 24 * 60 * 60 * 1000;
}

export type AuthorizationScopeDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "account_out_of_scope"
        | "product_out_of_scope"
        | "platform_out_of_scope"
        | "action_not_permitted";
    };

/**
 * Pure scope check against an already-loaded authorization.
 *
 * Account and product are checked only when the item carries one — an
 * item with no account is not constrained by the account scope. This
 * preserves the pre-existing semantics. Platform and action type are
 * always checked.
 */
export function evaluateAuthorizationScope(input: {
  scope: WeeklyContractScope;
  accountId: string | null;
  productId: string | null;
  platform: string;
  actionType: WeeklyContractActionType;
}): AuthorizationScopeDecision {
  const { scope, accountId, productId, platform, actionType } = input;
  if (accountId && !scope.accountIds.includes(accountId)) {
    return { allowed: false, reason: "account_out_of_scope" };
  }
  if (productId && !scope.productIds.includes(productId)) {
    return { allowed: false, reason: "product_out_of_scope" };
  }
  if (!scope.platforms.includes(platform)) {
    return { allowed: false, reason: "platform_out_of_scope" };
  }
  if (!scope.allowedActions.includes(actionType)) {
    return { allowed: false, reason: "action_not_permitted" };
  }
  return { allowed: true };
}

/**
 * Load the workspace's active authorization and classify it against a
 * single captured `now`.
 *
 * Only rows with `status = 'active'` are considered. A revoked, paused,
 * expired or draft row therefore does not authorize anything — and it
 * does not block the deliberate contract-free path either, which is
 * what keeps a stale envelope from permanently freezing per-item
 * scheduling.
 *
 * @throws ActiveAuthorizationLoadError when either load fails. Never
 *         returns `none` because of an error.
 */
export async function resolveActiveAuthorization(input: {
  workspaceId: string;
  nowMs: number;
  db?: SupabaseClient;
}): Promise<ActiveAuthorizationResolution> {
  const supabase = resolveDb(input.db);

  let row: WeeklyApprovalContractRow | null;
  try {
    row = await selectActiveContractRow(input.workspaceId, supabase);
  } catch (err) {
    throw new ActiveAuthorizationLoadError("contract", err);
  }
  if (!row) return { outcome: "none" };

  let scope: WeeklyContractScope;
  try {
    scope = await loadContractScope(input.workspaceId, row.id, supabase);
  } catch (err) {
    throw new ActiveAuthorizationLoadError("scope", err);
  }

  const contract: WeeklyContract = { ...toContractBase(row), scope };

  const boundaryMs = authorizationWindowEndExclusiveMs(contract.weekEnd);
  if (boundaryMs === null) return { outcome: "malformed_boundary", contract };
  if (input.nowMs >= boundaryMs) return { outcome: "expired", contract };

  return { outcome: "active", contract };
}

/**
 * Rows a paused-relevance sweep considers, in a deterministic order.
 *
 * Unlike `active`, `paused` is NOT constrained to one row per
 * workspace — `weekly_contracts_one_active_per_workspace`
 * (20260522040001:91) is a partial unique index `where status =
 * 'active'`. Several paused envelopes can therefore coexist, so this
 * returns a list and orders it so the classification is stable.
 */
async function selectPausedContractRows(
  workspaceId: string,
  supabase: SupabaseClient,
): Promise<WeeklyApprovalContractRow[]> {
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "paused")
    .order("week_start", { ascending: false })
    .order("id", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to load paused contracts.");
  return (data ?? []) as unknown as WeeklyApprovalContractRow[];
}

/** The item attributes an authorization is evaluated against. */
export interface AuthorizationSubject {
  accountId: string | null;
  productId: string | null;
  platform: string;
  actionType: WeeklyContractActionType;
}

export type PublishingAuthorizationClassification =
  /** No authorization governs this subject. */
  | { kind: "none" }
  | { kind: "active_in_scope"; contract: WeeklyContract }
  | {
      kind: "active_out_of_scope";
      contract: WeeklyContract;
      reason: Extract<
        AuthorizationScopeDecision,
        { allowed: false }
      >["reason"];
    }
  | { kind: "active_expired"; contract: WeeklyContract }
  | { kind: "active_malformed_boundary"; contract: WeeklyContract }
  /** A paused envelope that would govern this subject if resumed. */
  | { kind: "paused_relevant"; contract: WeeklyContract };

/**
 * Canonical authorization classification.
 *
 * Produces the same status / window / scope reading for every caller.
 * It deliberately stops short of a verdict: callers apply their own
 * policy on top, because their product semantics genuinely differ
 * (MCP permits contract-free scheduling; the safe-test pre-flight
 * requires an active envelope; the publisher does not re-authorize at
 * all — see PR #91).
 *
 * Ordering rules:
 *
 *   1. An active row governs outright. Paused rows are then irrelevant,
 *      because the operator's live envelope is the operative one.
 *   2. With no active row, a paused row governs only if it is
 *      RELEVANT: still inside its window AND covering this subject on
 *      all four scope axes. That is what stops an unrelated paused
 *      envelope — a different product, platform, or a week long past —
 *      from freezing deliberate contract-free publishing.
 *   3. A paused row whose boundary is unparseable is treated as
 *      relevant when it covers the subject: we cannot prove it is
 *      stale, so we fail closed.
 *
 * @throws ActiveAuthorizationLoadError on any load failure. A failure
 *         is never reported as "no authorization".
 */
export async function classifyPublishingAuthorization(input: {
  workspaceId: string;
  subject: AuthorizationSubject;
  nowMs: number;
  db?: SupabaseClient;
}): Promise<PublishingAuthorizationClassification> {
  const supabase = resolveDb(input.db);

  const active = await resolveActiveAuthorization({
    workspaceId: input.workspaceId,
    nowMs: input.nowMs,
    db: supabase,
  });

  if (active.outcome === "malformed_boundary") {
    return { kind: "active_malformed_boundary", contract: active.contract };
  }
  if (active.outcome === "expired") {
    return { kind: "active_expired", contract: active.contract };
  }
  if (active.outcome === "active") {
    const decision = evaluateAuthorizationScope({
      scope: active.contract.scope,
      ...input.subject,
    });
    return decision.allowed
      ? { kind: "active_in_scope", contract: active.contract }
      : {
          kind: "active_out_of_scope",
          contract: active.contract,
          reason: decision.reason,
        };
  }

  // No active envelope — does a paused one still govern this subject?
  let pausedRows: WeeklyApprovalContractRow[];
  try {
    pausedRows = await selectPausedContractRows(input.workspaceId, supabase);
  } catch (err) {
    throw new ActiveAuthorizationLoadError("contract", err);
  }

  for (const row of pausedRows) {
    let scope: WeeklyContractScope;
    try {
      scope = await loadContractScope(input.workspaceId, row.id, supabase);
    } catch (err) {
      throw new ActiveAuthorizationLoadError("scope", err);
    }
    const contract: WeeklyContract = { ...toContractBase(row), scope };

    const boundaryMs = authorizationWindowEndExclusiveMs(contract.weekEnd);
    // A paused envelope whose window has already closed is spent: it
    // cannot be resumed into a governing state, so it does not block.
    if (boundaryMs !== null && input.nowMs >= boundaryMs) continue;

    const decision = evaluateAuthorizationScope({ scope, ...input.subject });
    if (decision.allowed) return { kind: "paused_relevant", contract };
  }

  return { kind: "none" };
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

/**
 * The single query that defines "the active approval contract for
 * this workspace". Shared by `getActiveContract` and
 * `resolveActiveAuthorization` so contract selection is never
 * duplicated.
 */
async function selectActiveContractRow(
  workspaceId: string,
  supabase: SupabaseClient,
): Promise<WeeklyApprovalContractRow | null> {
  const { data, error } = await supabase
    .from("weekly_approval_contracts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load active weekly contract.");
  if (!data) return null;
  return data as unknown as WeeklyApprovalContractRow;
}

export async function getActiveContract(
  workspaceId: string,
  db?: SupabaseClient,
): Promise<WeeklyContract | null> {
  const supabase = resolveDb(db);
  const row = await selectActiveContractRow(workspaceId, supabase);
  if (!row) return null;
  const scope = await loadContractScope(workspaceId, row.id, supabase);
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
