import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  NotificationInsert,
  NotificationRow,
  NotificationStatus,
  NotificationType,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

/**
 * Phase C2.1 — notifications. Recipient-scoped (RLS: a user reads/
 * updates only their own). Content is always source-of-truth derived
 * by the caller. `dedupe_key` collapses repeated events into one row.
 */

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  userId: string;
  type: NotificationType;
  status: NotificationStatus;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  readAt: string | null;
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export interface CreateNotificationInput {
  workspaceId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey?: string | null;
  db?: SupabaseClient;
}

/**
 * Insert a notification. When `dedupeKey` is set, a duplicate (same
 * recipient + key) is a no-op (the partial unique index + ignore-on-
 * conflict). Best-effort by contract: callers wrap so a notification
 * write never blocks the underlying action.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  const supabase = input.db ?? createSupabaseServerClient();
  const insert: NotificationInsert = {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    dedupe_key: input.dedupeKey ?? null,
  };
  const query = supabase.from("notifications");
  const { error } = input.dedupeKey
    ? await query
        .upsert(insert as never, {
          onConflict: "user_id,dedupe_key",
          ignoreDuplicates: true,
        })
    : await query.insert(insert as never);
  if (error) throw fromPostgres(error, "Failed to create notification.");
}

export interface NotificationPage {
  rows: NotificationRecord[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listNotificationsPage(input: {
  workspaceId: string;
  userId: string;
  statuses?: NotificationStatus[];
  page?: number;
  pageSize?: number;
}): Promise<NotificationPage> {
  const supabase = createSupabaseServerClient();
  const size = Math.max(1, Math.min(100, input.pageSize ?? 20));
  const page = Math.max(1, input.page ?? 1);
  const from = (page - 1) * size;
  const to = from + size - 1;

  let q = supabase
    .from("notifications")
    .select("*", { count: "exact" })
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId);
  if (input.statuses && input.statuses.length > 0) {
    q = q.in("status", input.statuses as never);
  }
  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw fromPostgres(error, "Failed to list notifications.");

  const unread = await countUnreadNotifications(input.workspaceId, input.userId);
  const total = count ?? 0;
  return {
    rows: ((data ?? []) as unknown as NotificationRow[]).map(toRecord),
    total,
    unread,
    page,
    pageSize: size,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

export async function countUnreadNotifications(
  workspaceId: string,
  userId: string,
): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "unread");
  if (error) throw fromPostgres(error, "Failed to count notifications.");
  return count ?? 0;
}

export async function markNotification(input: {
  id: string;
  status: NotificationStatus;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const patch =
    input.status === "read"
      ? { status: "read", read_at: new Date().toISOString() }
      : { status: input.status };
  const { error } = await supabase
    .from("notifications")
    .update(patch as never)
    .eq("id", input.id); // RLS restricts to the caller's own rows
  if (error) throw fromPostgres(error, "Failed to update notification.");
}

export async function markAllNotificationsRead(input: {
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("notifications")
    .update({ status: "read", read_at: new Date().toISOString() } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .eq("status", "unread");
  if (error) throw fromPostgres(error, "Failed to mark notifications read.");
}
