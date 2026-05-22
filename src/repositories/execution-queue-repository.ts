import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionQueueInsert,
  ExecutionQueueRow,
  ExecutionQueueUpdate,
} from "@/lib/supabase/types";
import type { ExecutionQueue, ExecutionQueueStatus } from "@/core/execution-engine";
import { transitionQueue } from "@/core/execution-engine";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

function toQueue(row: ExecutionQueueRow): ExecutionQueue {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contractId: row.contract_id,
    createdBy: row.created_by,
    title: row.title,
    status: row.status,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateExecutionQueueInput {
  workspaceId: string;
  contractId: string;
  title: string;
  weekStart: string;
  weekEnd: string;
}

export async function createExecutionQueue(
  input: CreateExecutionQueueInput,
): Promise<ExecutionQueue> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const insert: ExecutionQueueInsert = {
    workspace_id: input.workspaceId,
    contract_id: input.contractId,
    created_by: user.id,
    title: input.title,
    status: "draft",
    week_start: input.weekStart,
    week_end: input.weekEnd,
  };
  const { data, error } = await supabase
    .from("execution_queues")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create execution queue.");
  return toQueue(data as unknown as ExecutionQueueRow);
}

export async function getExecutionQueueById(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", queueId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load execution queue.");
  if (!data) throw notFound("Execution queue");
  return toQueue(data as unknown as ExecutionQueueRow);
}

export async function listExecutionQueues(
  workspaceId: string,
  limit = 20,
): Promise<ExecutionQueue[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("week_start", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list execution queues.");
  return ((data ?? []) as unknown as ExecutionQueueRow[]).map(toQueue);
}

export async function getActiveExecutionQueue(
  workspaceId: string,
  contractId: string,
): Promise<ExecutionQueue | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_queues")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("contract_id", contractId)
    .in("status", ["draft", "ready", "running", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load active execution queue.");
  if (!data) return null;
  return toQueue(data as unknown as ExecutionQueueRow);
}

async function setQueueStatus(
  workspaceId: string,
  queueId: string,
  to: ExecutionQueueStatus,
  patch: ExecutionQueueUpdate = {},
): Promise<ExecutionQueue> {
  const current = await getExecutionQueueById(workspaceId, queueId);
  const verdict = transitionQueue(current.status, to);
  if (!verdict.ok) throw verdict.error;
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("execution_queues")
    .update({ ...patch, status: to } as never)
    .eq("workspace_id", workspaceId)
    .eq("id", queueId);
  if (error) throw fromPostgres(error, "Failed to update queue status.");
  return getExecutionQueueById(workspaceId, queueId);
}

export async function markQueueReady(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  return setQueueStatus(workspaceId, queueId, "ready");
}

export async function pauseQueue(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  return setQueueStatus(workspaceId, queueId, "paused");
}

export async function resumeQueue(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  return setQueueStatus(workspaceId, queueId, "ready");
}

export async function cancelQueue(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  return setQueueStatus(workspaceId, queueId, "cancelled");
}

export async function markQueueCompleted(
  workspaceId: string,
  queueId: string,
): Promise<ExecutionQueue> {
  return setQueueStatus(workspaceId, queueId, "completed");
}
