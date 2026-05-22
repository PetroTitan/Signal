import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ApprovalAction,
  ApprovalEventInsert,
  ApprovalEventRow,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface ApprovalEvent {
  id: string;
  workspaceId: string;
  weeklyPlanItemId: string | null;
  actorUserId: string | null;
  action: ApprovalAction;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toEvent(row: ApprovalEventRow): ApprovalEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    weeklyPlanItemId: row.weekly_plan_item_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    note: row.note,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function listApprovalEvents(
  workspaceId: string,
  limit = 50,
): Promise<ApprovalEvent[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("approval_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list approval events.");
  return ((data ?? []) as unknown as ApprovalEventRow[]).map(toEvent);
}

export async function listApprovalEventsForItem(
  workspaceId: string,
  itemId: string,
): Promise<ApprovalEvent[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("approval_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("weekly_plan_item_id", itemId)
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list approval events.");
  return ((data ?? []) as unknown as ApprovalEventRow[]).map(toEvent);
}

export interface ApprovalEventInput {
  workspaceId: string;
  weeklyPlanItemId?: string | null;
  action: ApprovalAction;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordApprovalEvent(
  input: ApprovalEventInput,
): Promise<ApprovalEvent> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const insert: ApprovalEventInsert = {
    workspace_id: input.workspaceId,
    weekly_plan_item_id: input.weeklyPlanItemId ?? null,
    actor_user_id: user?.id ?? null,
    action: input.action,
    note: input.note ?? null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("approval_events")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to record approval event.");
  return toEvent(data as unknown as ApprovalEventRow);
}
