import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ExecutionAttemptInsert,
  ExecutionAttemptRow,
  ExecutionAttemptUpdate,
} from "@/lib/supabase/types";
import type {
  ExecutionAttempt,
  ExecutionAttemptStatus,
} from "@/core/execution-engine";
import { fromPostgres, notFound } from "./errors";

function toAttempt(row: ExecutionAttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionItemId: row.execution_item_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorSummary: row.error_summary,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function startAttempt(input: {
  workspaceId: string;
  itemId: string;
  attemptNumber: number;
  metadata?: Record<string, unknown>;
}): Promise<ExecutionAttempt> {
  const supabase = createSupabaseServerClient();
  const insert: ExecutionAttemptInsert = {
    workspace_id: input.workspaceId,
    execution_item_id: input.itemId,
    attempt_number: input.attemptNumber,
    status: "started",
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("execution_attempts")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to start execution attempt.");
  return toAttempt(data as unknown as ExecutionAttemptRow);
}

export async function finishAttempt(input: {
  workspaceId: string;
  attemptId: string;
  status: ExecutionAttemptStatus;
  errorSummary?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ExecutionAttempt> {
  const supabase = createSupabaseServerClient();
  const patch: ExecutionAttemptUpdate = {
    status: input.status,
    finished_at: new Date().toISOString(),
    error_summary: input.errorSummary ?? null,
    metadata: input.metadata,
  };
  const { data, error } = await supabase
    .from("execution_attempts")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.attemptId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to finish execution attempt.");
  return toAttempt(data as unknown as ExecutionAttemptRow);
}

export async function markAttemptFailed(input: {
  workspaceId: string;
  attemptId: string;
  errorSummary: string;
}): Promise<ExecutionAttempt> {
  return finishAttempt({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    status: "failed",
    errorSummary: input.errorSummary,
  });
}

export async function listAttemptsForItem(
  workspaceId: string,
  itemId: string,
): Promise<ExecutionAttempt[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_attempts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("execution_item_id", itemId)
    .order("attempt_number", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list execution attempts.");
  return ((data ?? []) as unknown as ExecutionAttemptRow[]).map(toAttempt);
}

export async function getAttemptById(
  workspaceId: string,
  attemptId: string,
): Promise<ExecutionAttempt> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("execution_attempts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", attemptId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load execution attempt.");
  if (!data) throw notFound("Execution attempt");
  return toAttempt(data as unknown as ExecutionAttemptRow);
}
