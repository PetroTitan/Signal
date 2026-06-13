import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionItemInsert,
  ExecutionItemRow,
  ExecutionItemUpdate,
} from "@/lib/supabase/types";
import type {
  ExecutionItem,
  ExecutionItemRiskLevel,
  ExecutionItemStatus,
} from "@/core/execution-engine";
import { transitionItem } from "@/core/execution-engine";
import { fromPostgres, notFound } from "./errors";

function toItem(row: ExecutionItemRow): ExecutionItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    queueId: row.queue_id,
    contractId: row.contract_id,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    productId: row.product_id,
    accountId: row.account_id,
    platform: row.platform,
    actionType: row.action_type,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    scheduledAt: row.scheduled_at,
    status: row.status,
    riskScore: row.risk_score,
    riskLevel: row.risk_level,
    authorizationId: row.authorization_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateExecutionItemInput {
  workspaceId: string;
  queueId: string;
  /** Optional. NULL for contract-free per-post items. */
  contractId: string | null;
  actionType: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  productId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  title?: string | null;
  body?: string | null;
  linkUrl?: string | null;
  scheduledAt?: string | null;
  riskScore?: number | null;
  riskLevel?: ExecutionItemRiskLevel | null;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export async function createExecutionItem(
  input: CreateExecutionItemInput,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  // contract_id is nullable post-migration; cast through `unknown`
  // until Supabase types are regenerated.
  const insert = {
    workspace_id: input.workspaceId,
    queue_id: input.queueId,
    contract_id: input.contractId,
    source_entity_type: input.sourceEntityType ?? null,
    source_entity_id: input.sourceEntityId ?? null,
    product_id: input.productId ?? null,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    action_type: input.actionType,
    title: input.title ?? null,
    body: input.body ?? null,
    link_url: input.linkUrl ?? null,
    scheduled_at: input.scheduledAt ?? null,
    status: "pending_authorization",
    risk_score: input.riskScore ?? null,
    risk_level: input.riskLevel ?? null,
    max_attempts: input.maxAttempts ?? 3,
    metadata: input.metadata ?? {},
  } as unknown as ExecutionItemInsert;
  const { data, error } = await supabase
    .from("execution_items")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create execution item.");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function getExecutionItemById(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load execution item.");
  if (!data) throw notFound("Execution item");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function listItemsForQueue(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("queue_id", queueId)
    .order("scheduled_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list execution items.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

export async function listUpcomingScheduledItems(
  workspaceId: string,
  limit = 20,
): Promise<ExecutionItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "scheduled")
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error)
    throw fromPostgres(error, "Failed to list upcoming scheduled items.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

/**
 * Phase F2.5 — find execution_items tied to a given set of
 * weekly_plan_items (via metadata.plan_item_id). Used by
 * /weekly-plan to surface the READY_FOR_PUBLISH badge.
 */
export async function listExecutionItemsByPlanItemIds(
  workspaceId: string,
  planItemIds: string[],
): Promise<ExecutionItem[]> {
  if (planItemIds.length === 0) return [];
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("source_entity_id", planItemIds)
    .order("scheduled_at", { ascending: true });
  if (error)
    throw fromPostgres(error, "Failed to list execution items by plan-item.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

/**
 * A5 — batch-resolve display fields for a page of publish-history rows.
 *
 * publish_history stores `execution_item_id` but no title text; the
 * title + originating plan item live on execution_items. This returns a
 * Map keyed by execution_item id → { title, sourceEntityId (plan item),
 * accountId } for the (≤ page-size) ids on the current page, so the
 * history table can show a human title + deep-link to the source
 * without an N+1 query.
 */
export interface ExecutionItemDisplay {
  title: string | null;
  sourceEntityId: string | null;
  accountId: string | null;
  attemptCount: number | null;
  metadata: Record<string, unknown>;
}

export async function hydrateExecutionItemDisplay(
  workspaceId: string,
  executionItemIds: string[],
  db?: SupabaseClient,
): Promise<Map<string, ExecutionItemDisplay>> {
  const out = new Map<string, ExecutionItemDisplay>();
  const ids = Array.from(new Set(executionItemIds)).filter(Boolean);
  if (ids.length === 0) return out;
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("id, title, source_entity_id, account_id, attempt_count, metadata")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  if (error)
    throw fromPostgres(error, "Failed to hydrate execution-item display.");
  for (const row of (data ?? []) as Array<{
    id: string;
    title: string | null;
    source_entity_id: string | null;
    account_id: string | null;
    attempt_count: number | null;
    metadata: Record<string, unknown> | null;
  }>) {
    out.set(row.id, {
      title: row.title,
      sourceEntityId: row.source_entity_id,
      accountId: row.account_id,
      attemptCount: row.attempt_count,
      metadata: row.metadata ?? {},
    });
  }
  return out;
}

/**
 * B7 — accurate count of execution items in given statuses (head
 * count, not capped). `minAttemptCount` isolates the retry queue.
 */
export async function countExecutionItemsByStatus(
  workspaceId: string,
  statuses: string[],
  opts?: { minAttemptCount?: number },
  db?: SupabaseClient,
): Promise<number> {
  if (statuses.length === 0) return 0;
  const supabase = db ?? createSupabaseServerClient();
  let query = supabase
    .from("execution_items")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("status", statuses);
  if (typeof opts?.minAttemptCount === "number") {
    query = query.gte("attempt_count", opts.minAttemptCount);
  }
  const { count, error } = await query;
  if (error) throw fromPostgres(error, "Failed to count execution items.");
  return count ?? 0;
}

/**
 * A3/A4 — operator-initiated "try again" for a FAILED execution item.
 *
 * Guarded compare-and-set: only a row still in `failed` is requeued to
 * `scheduled` (status machine allows failed → scheduled), so this is
 * idempotent and races safely with the scheduler. It resets the
 * attempt budget (the operator presumably fixed the cause), clears the
 * stale retry/claim records, stamps a manual-retry marker, and sets
 * `scheduled_at = now` so the next tick picks it up. It does NOT change
 * approval state — `failed` items were already authorized, and
 * `scheduled` is the same state they held at approval, so manual retry
 * never bypasses approval. Returns false when no `failed` row matched.
 */
export async function requeueFailedExecutionItem(input: {
  workspaceId: string;
  itemId: string;
  nowIso: string;
  currentMetadata: Record<string, unknown>;
}): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { retry: _drop, scheduler_claim: _dropClaim, ...rest } =
    input.currentMetadata as Record<string, unknown> & {
      retry?: unknown;
      scheduler_claim?: unknown;
    };
  const metadata = {
    ...rest,
    manual_retry: { requeued_at: input.nowIso },
  };
  const { data, error } = await supabase
    .from("execution_items")
    .update({
      status: "scheduled",
      scheduled_at: input.nowIso,
      attempt_count: 0,
      metadata,
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.itemId)
    .eq("status", "failed")
    .select("id");
  if (error) throw fromPostgres(error, "Failed to requeue execution item.");
  return Array.isArray(data) && data.length > 0;
}

/**
 * A4 — generic status query for the operator-attention surface
 * (failed / blocked / running [stale claims] / scheduled-with-retries).
 * `minAttemptCount` lets the caller isolate "scheduled BUT already
 * attempted" = currently retrying. Read-only.
 */
export async function listExecutionItemsByStatus(
  workspaceId: string,
  statuses: string[],
  opts?: { limit?: number; minAttemptCount?: number },
): Promise<ExecutionItem[]> {
  if (statuses.length === 0) return [];
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", statuses);
  if (typeof opts?.minAttemptCount === "number") {
    query = query.gte("attempt_count", opts.minAttemptCount);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(opts?.limit ?? 20);
  if (error)
    throw fromPostgres(error, "Failed to list execution items by status.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

export async function listRecentResultItems(
  workspaceId: string,
  limit = 20,
): Promise<ExecutionItem[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("status", ["completed", "failed", "blocked", "skipped"])
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error)
    throw fromPostgres(error, "Failed to list recent execution items.");
  return ((data ?? []) as unknown as ExecutionItemRow[]).map(toItem);
}

async function applyItemUpdate(
  workspaceId: string,
  itemId: string,
  patch: ExecutionItemUpdate,
): Promise<ExecutionItem> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_items")
    .update(patch as never)
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update execution item.");
  return toItem(data as unknown as ExecutionItemRow);
}

export async function updateItemStatus(input: {
  workspaceId: string;
  itemId: string;
  to: ExecutionItemStatus;
  patch?: ExecutionItemUpdate;
}): Promise<ExecutionItem> {
  const current = await getExecutionItemById(input.workspaceId, input.itemId);
  const verdict = transitionItem(current.status, input.to);
  if (!verdict.ok) throw verdict.error;
  return applyItemUpdate(input.workspaceId, input.itemId, {
    ...(input.patch ?? {}),
    status: input.to,
  });
}

export async function attachAuthorization(input: {
  workspaceId: string;
  itemId: string;
  authorizationId: string;
}): Promise<ExecutionItem> {
  return applyItemUpdate(input.workspaceId, input.itemId, {
    authorization_id: input.authorizationId,
  });
}

export async function incrementAttemptCount(input: {
  workspaceId: string;
  itemId: string;
}): Promise<ExecutionItem> {
  const current = await getExecutionItemById(input.workspaceId, input.itemId);
  return applyItemUpdate(input.workspaceId, input.itemId, {
    attempt_count: current.attemptCount + 1,
  });
}

export async function moveItemToBacklog(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "backlogged" });
}

export async function markItemSkipped(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "skipped" });
}

export async function markItemBlocked(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "blocked" });
}

export async function markItemCompleted(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionItem> {
  return updateItemStatus({ workspaceId, itemId, to: "completed" });
}

/**
 * Mirror weekly_plan_items.scheduled_at onto an active execution_item.
 *
 * The orchestrator
 * (`src/core/scheduling/resync-execution-item-schedule.server.ts`)
 * has already classified the row as resync-eligible via
 * `classifyResyncTarget`. This repository call applies the change
 * and stamps audit fields onto metadata. It refuses defensively if
 * the row's status has drifted to a non-eligible value between
 * classification and write — preventing a future caller from
 * accidentally rewriting a terminal or running row.
 *
 * `scheduled_at` is the ONLY column touched besides `metadata`.
 * `contract_id`, `account_id`, `platform`, `body`, `title`,
 * `risk_*`, `status`, `attempt_count`, `max_attempts` are preserved
 * — the resync is a schedule shift, not a re-authorization.
 */
export async function applyExecutionItemScheduleResync(input: {
  workspaceId: string;
  itemId: string;
  nextScheduledAt: string;
  previousScheduledAt: string | null;
  source: "ui" | "mcp";
}): Promise<ExecutionItem> {
  const current = await getExecutionItemById(input.workspaceId, input.itemId);
  if (
    current.status !== "pending_authorization" &&
    current.status !== "authorized" &&
    current.status !== "scheduled"
  ) {
    throw new Error(
      `Refusing to resync execution_item ${input.itemId}: status=${current.status} is not eligible.`,
    );
  }
  const prevMeta = (current.metadata ?? {}) as Record<string, unknown>;
  const nextMeta: Record<string, unknown> = {
    ...prevMeta,
    schedule_resynced_from_plan_item: true,
    schedule_resynced_at: new Date().toISOString(),
    schedule_resynced_source: input.source,
    schedule_resynced_previous_scheduled_at: input.previousScheduledAt,
  };
  return applyItemUpdate(input.workspaceId, input.itemId, {
    scheduled_at: input.nextScheduledAt,
    metadata: nextMeta,
  });
}
