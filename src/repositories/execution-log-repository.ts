import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionLogInsert,
  ExecutionLogRow,
} from "@/lib/supabase/types";
import type {
  ComposedLog,
  ExecutionLog,
} from "@/core/execution-engine";
import { fromPostgres } from "./errors";

function toLog(row: ExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    queueId: row.queue_id,
    executionItemId: row.execution_item_id,
    eventType: row.event_type,
    severity: row.severity,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function recordLog(input: ComposedLog): Promise<ExecutionLog> {
  const supabase = createSupabaseServerClient();
  const insert: ExecutionLogInsert = {
    workspace_id: input.workspaceId,
    queue_id: input.queueId,
    execution_item_id: input.executionItemId,
    event_type: input.eventType,
    severity: input.severity,
    message: input.message,
    metadata: input.metadata,
  };
  const { data, error } = await supabase
    .from("execution_logs")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to record execution log.");
  return toLog(data as unknown as ExecutionLogRow);
}

export async function recordLogs(
  inputs: ReadonlyArray<ComposedLog>,
): Promise<ExecutionLog[]> {
  if (inputs.length === 0) return [];
  const supabase = createSupabaseServerClient();
  const rows: ExecutionLogInsert[] = inputs.map((i) => ({
    workspace_id: i.workspaceId,
    queue_id: i.queueId,
    execution_item_id: i.executionItemId,
    event_type: i.eventType,
    severity: i.severity,
    message: i.message,
    metadata: i.metadata,
  }));
  const { data, error } = await supabase
    .from("execution_logs")
    .insert(rows as never)
    .select("*");
  if (error) throw fromPostgres(error, "Failed to record execution logs.");
  return ((data ?? []) as unknown as ExecutionLogRow[]).map(toLog);
}

export async function listLogsForQueue(
  workspaceId: string,
  queueId: string,
  limit = 200,
): Promise<ExecutionLog[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_logs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("queue_id", queueId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list execution logs.");
  return ((data ?? []) as unknown as ExecutionLogRow[]).map(toLog);
}

export async function listLogsForItem(
  workspaceId: string,
  itemId: string,
  limit = 100,
): Promise<ExecutionLog[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_logs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("execution_item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list execution logs.");
  return ((data ?? []) as unknown as ExecutionLogRow[]).map(toLog);
}
