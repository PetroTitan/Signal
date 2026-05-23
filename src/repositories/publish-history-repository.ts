import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  PublishHistoryInsert,
  PublishHistoryRow,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

export interface PublishHistoryEntry {
  id: string;
  workspaceId: string;
  executionItemId: string;
  accountId: string | null;
  productId: string | null;
  platform: string;
  subreddit: string | null;
  fingerprint: string;
  titleHash: string | null;
  bodyHash: string | null;
  linkUrl: string | null;
  providerPostId: string | null;
  providerPermalink: string | null;
  outcome: "published" | "failed" | "blocked";
  reasonCode: string | null;
  httpStatus: number | null;
  startedAt: string;
  finishedAt: string;
  metadata: Record<string, unknown>;
}

function toEntry(row: PublishHistoryRow): PublishHistoryEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionItemId: row.execution_item_id,
    accountId: row.account_id,
    productId: row.product_id,
    platform: row.platform,
    subreddit: row.subreddit,
    fingerprint: row.fingerprint,
    titleHash: row.title_hash,
    bodyHash: row.body_hash,
    linkUrl: row.link_url,
    providerPostId: row.provider_post_id,
    providerPermalink: row.provider_permalink,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    httpStatus: row.http_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    metadata: row.metadata,
  };
}

export interface InsertPublishHistoryInput {
  workspaceId: string;
  executionItemId: string;
  accountId: string | null;
  productId: string | null;
  platform: string;
  subreddit: string | null;
  fingerprint: string;
  titleHash: string | null;
  bodyHash: string | null;
  linkUrl: string | null;
  providerPostId: string | null;
  providerPermalink: string | null;
  outcome: "published" | "failed" | "blocked";
  reasonCode: string | null;
  httpStatus: number | null;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export async function insertPublishHistory(
  input: InsertPublishHistoryInput,
): Promise<PublishHistoryEntry> {
  const supabase = createSupabaseServerClient();
  const insert: PublishHistoryInsert = {
    workspace_id: input.workspaceId,
    execution_item_id: input.executionItemId,
    account_id: input.accountId,
    product_id: input.productId,
    platform: input.platform,
    subreddit: input.subreddit,
    fingerprint: input.fingerprint,
    title_hash: input.titleHash,
    body_hash: input.bodyHash,
    link_url: input.linkUrl,
    provider_post_id: input.providerPostId,
    provider_permalink: input.providerPermalink,
    outcome: input.outcome,
    reason_code: input.reasonCode,
    http_status: input.httpStatus,
    started_at: input.startedAt,
    metadata: input.metadata ?? {},
  };
  const { data, error } = await supabase
    .from("publish_history")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to record publish history.");
  return toEntry(data as unknown as PublishHistoryRow);
}

/**
 * Count successful publishes since a given timestamp. Used by the
 * rate-limit policy:
 *   - countPublishesSince(workspace, now - 60min)   → must be 0
 *   - countPublishesSince(workspace, now - 24h)     → must be < 3
 */
export async function countPublishesSince(
  workspaceId: string,
  sinceIso: string,
): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("publish_history")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("outcome", "published")
    .gte("finished_at", sinceIso);
  if (error)
    throw fromPostgres(error, "Failed to count recent publishes.");
  return count ?? 0;
}

/**
 * Returns the most recent successful publish with this fingerprint
 * within a window. Used by the duplicate-content policy.
 */
export async function findRecentDuplicate(input: {
  workspaceId: string;
  fingerprint: string;
  sinceIso: string;
}): Promise<PublishHistoryEntry | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("publish_history")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("fingerprint", input.fingerprint)
    .eq("outcome", "published")
    .gte("finished_at", input.sinceIso)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    throw fromPostgres(error, "Failed to look up duplicate publish.");
  if (!data) return null;
  return toEntry(data as unknown as PublishHistoryRow);
}

export async function listRecentPublishes(
  workspaceId: string,
  limit = 20,
): Promise<PublishHistoryEntry[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("publish_history")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Failed to list publish history.");
  return ((data ?? []) as unknown as PublishHistoryRow[]).map(toEntry);
}

export async function getPublishHistoryForItem(
  workspaceId: string,
  executionItemId: string,
): Promise<PublishHistoryEntry | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("publish_history")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("execution_item_id", executionItemId)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    throw fromPostgres(error, "Failed to load publish history for item.");
  if (!data) return null;
  return toEntry(data as unknown as PublishHistoryRow);
}
