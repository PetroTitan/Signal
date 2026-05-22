import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ActivityEventInsert,
  ActivityEventRow,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface ActivityEventRecord {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toEvent(row: ActivityEventRow): ActivityEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function listRecentActivity(
  workspaceId: string,
  limit = 50,
): Promise<ActivityEventRecord[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("activity_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list activity.");
  return ((data ?? []) as unknown as ActivityEventRow[]).map(toEvent);
}

export interface ActivityEventInput {
  workspaceId: string;
  eventType: string;
  title: string;
  description?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordActivity(
  input: ActivityEventInput,
): Promise<ActivityEventRecord> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const insert: ActivityEventInsert = {
    workspace_id: input.workspaceId,
    actor_user_id: user?.id ?? null,
    event_type: input.eventType,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    title: input.title,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("activity_events")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to record activity.");
  return toEvent(data as unknown as ActivityEventRow);
}
