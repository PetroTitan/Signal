import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  mode: "api" | "manual";
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
    mode: row.mode,
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
  /** Phase F2.6: distinguishes API publishes from manual records.
   *  Defaults to 'api' at the DB layer; the manual path passes
   *  'manual' explicitly. */
  mode?: "api" | "manual";
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
    mode: input.mode ?? "api",
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
  /** Optional injected client; see getAccountById's doc note. */
  db?: SupabaseClient,
): Promise<PublishHistoryEntry[]> {
  const supabase = db ?? createSupabaseServerClient();
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

// =====================================================================
// Scheduler upsert — persist cron-driven publish attempts
// =====================================================================
//
// Background
// ----------
// Manual publish actions (the /execution/items/[id] tier-one + record
// flows, the MCP confirm tool) call `insertPublishHistory` directly.
// The scheduler tick's `applyOutcome` historically wrote
// execution_items + execution_logs but skipped publish_history, so
// every scheduler-driven publish left publish_history empty. This
// helper closes that gap.
//
// Dedup strategy
// --------------
// The schema has NO unique constraint on `execution_item_id` (only on
// `(workspace_id, provider_permalink) WHERE permalink IS NOT NULL`),
// so we do application-layer read-modify-write keyed on
// `(execution_item_id, mode='api')`. Manual rows (`mode='manual'`) are
// never read or touched.
//
// Rules:
//   - absent           → INSERT
//   - existing 'published' + new 'failed/blocked' → NO-OP
//     (don't downgrade richer success data to poorer failure data)
//   - existing 'failed/blocked' + new 'published' → UPDATE
//     (success replaces prior failure)
//   - same outcome    → UPDATE (refresh finished_at + metadata)
//
// Safety
// ------
// Metadata is built from an explicit whitelist (source, reason_code,
// reason_detail, http_status, endpoint, atproto_error, atproto_message,
// thread_length, media_attached, provider_attempted, contract_mode).
// The full `outcome.metadata` is NEVER copied wholesale — that's the
// only place where token-shaped fields could leak in via a future
// publisher change.

export type SchedulerOutcomeStatus = "published" | "failed" | "blocked";

export interface SchedulerHistoryUpsertInput {
  workspaceId: string;
  executionItemId: string;
  accountId: string | null;
  productId: string | null;
  platform: string;
  subreddit: string | null;
  /** Whitelisted scheduler outcome — already mapped from the
   *  PublishOutcome.status by the caller. */
  outcome: SchedulerOutcomeStatus;
  reasonCode: string | null;
  reasonDetail: string | null;
  providerPostId: string | null;
  providerPermalink: string | null;
  /** Stable per-content hash used by the duplicate-content policy. */
  fingerprint: string;
  titleHash: string | null;
  bodyHash: string | null;
  linkUrl: string | null;
  httpStatus: number | null;
  startedAt: string;
  /** Provider boundary marker. `false` for cases where the publish
   *  was blocked before the platform was contacted (e.g.
   *  creative_missing_alt_text); `true` once the request reached the
   *  AT Proto / Reddit / etc. transport. */
  providerAttempted: boolean;
  /** Optional Bluesky-specific diagnostic fields from
   *  outcome.metadata. Each is whitelisted explicitly. */
  threadLength?: number | null;
  mediaAttached?: boolean | null;
  endpoint?: string | null;
  atprotoError?: string | null;
  atprotoMessage?: string | null;
  contractMode?: string | null;
  /** Telegram-specific diagnostic field — records which scheduler
   *  path resolved the chat_id passed to the runner:
   *    - "metadata" → from execution_items.metadata.target (explicit
   *      override by the schedule-creating caller).
   *    - "platform_connection.provider_account_id" → fallback to the
   *      chat id stored on platform_connections at verify time.
   *    - null → neither source produced a value (publish refused
   *      upstream with missing_identifier).
   *  Operator-visible; chat id itself is not treated as a secret. */
  targetSource?:
    | "metadata"
    | "platform_connection.provider_account_id"
    | null;
  /** Telegram-specific diagnostic — operator-declared target type
   *  for this identity. Defaults to "channel" for legacy rows that
   *  predate the group/supergroup support. */
  telegramTargetType?: "channel" | "group" | "supergroup";
  /** Telegram-specific diagnostic — whether the scheduler resolved
   *  a non-empty target for this attempt. False indicates an
   *  upstream `missing_identifier` regression (chat id never
   *  reached the runner). */
  chatIdPresent?: boolean;
  /** Service-role client. Cron runtime has no operator cookie; RLS
   *  would hide publish_history without this. Manual callers can
   *  omit and use the cookie-aware client. */
  db?: SupabaseClient;
}

export type SchedulerHistoryUpsertResult =
  | { action: "inserted"; entry: PublishHistoryEntry }
  | { action: "updated"; entry: PublishHistoryEntry }
  | { action: "skipped_downgrade"; existing: PublishHistoryEntry };

/**
 * Look up the scheduler-written row (if any) for this execution_item
 * and apply the dedup rules.
 *
 * The function is idempotent within a single outcome status: calling
 * it twice with the same published outcome will refresh `finished_at`
 * + `metadata` but produce no duplicate row.
 */
export async function upsertSchedulerPublishHistoryFromOutcome(
  input: SchedulerHistoryUpsertInput,
): Promise<SchedulerHistoryUpsertResult> {
  const supabase = input.db ?? createSupabaseServerClient();

  // Build the safe metadata bag — explicit whitelist only.
  const metadata: Record<string, unknown> = {
    source: "scheduler",
    provider_attempted: input.providerAttempted,
  };
  if (input.reasonCode !== null) metadata.reason_code = input.reasonCode;
  if (input.reasonDetail !== null) metadata.reason_detail = input.reasonDetail;
  if (input.threadLength !== undefined && input.threadLength !== null) {
    metadata.thread_length = input.threadLength;
  }
  if (input.mediaAttached !== undefined && input.mediaAttached !== null) {
    metadata.media_attached = input.mediaAttached;
  }
  if (input.endpoint !== undefined && input.endpoint !== null) {
    metadata.endpoint = input.endpoint;
  }
  if (input.atprotoError !== undefined && input.atprotoError !== null) {
    metadata.atproto_error = input.atprotoError;
  }
  if (input.atprotoMessage !== undefined && input.atprotoMessage !== null) {
    metadata.atproto_message = input.atprotoMessage;
  }
  if (input.contractMode !== undefined && input.contractMode !== null) {
    metadata.contract_mode = input.contractMode;
  }
  if (input.targetSource !== undefined) {
    // Emit even when null — for Telegram, "we tried both sources and
    // got nothing" is itself diagnostic.
    metadata.target_source = input.targetSource;
  }
  if (input.telegramTargetType !== undefined) {
    metadata.telegram_target_type = input.telegramTargetType;
  }
  if (input.chatIdPresent !== undefined) {
    metadata.chat_id_present = input.chatIdPresent;
  }

  // 1. Look up the existing scheduler row (mode='api') for this exec
  // item. Manual rows are intentionally excluded.
  const { data: existing, error: lookupError } = await supabase
    .from("publish_history")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("execution_item_id", input.executionItemId)
    .eq("mode", "api")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    throw fromPostgres(lookupError, "Failed to look up publish history.");
  }

  if (!existing) {
    // INSERT path.
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
      mode: "api",
      reason_code: input.reasonCode,
      http_status: input.httpStatus,
      started_at: input.startedAt,
      metadata,
    };
    const { data: inserted, error: insertError } = await supabase
      .from("publish_history")
      .insert(insert as never)
      .select("*")
      .single();
    if (insertError || !inserted) {
      throw fromPostgres(insertError, "Failed to insert publish history.");
    }
    return {
      action: "inserted",
      entry: toEntry(inserted as unknown as PublishHistoryRow),
    };
  }

  const existingRow = existing as unknown as PublishHistoryRow;

  // 2. Downgrade guard — once we have a 'published' on disk, never
  // overwrite it with a later 'failed'/'blocked' outcome from a
  // subsequent (likely retry) attempt. The success record is the
  // truth.
  if (
    existingRow.outcome === "published" &&
    input.outcome !== "published"
  ) {
    return {
      action: "skipped_downgrade",
      existing: toEntry(existingRow),
    };
  }

  // 3. UPDATE path — refresh outcome + provider fields + metadata. We
  // do NOT clobber a non-null provider_permalink with null; that's
  // the unique-index column and also irreversible information once a
  // platform has assigned a URL.
  const update: Partial<PublishHistoryInsert> = {
    outcome: input.outcome,
    reason_code: input.reasonCode,
    http_status: input.httpStatus,
    started_at: input.startedAt,
    metadata,
  };
  if (input.providerPostId !== null) {
    (update as { provider_post_id?: string | null }).provider_post_id =
      input.providerPostId;
  }
  if (input.providerPermalink !== null) {
    (update as { provider_permalink?: string | null }).provider_permalink =
      input.providerPermalink;
  }
  // finished_at refreshes automatically? No — the DB default fires
  // on insert only. Refresh explicitly so the operator sees the
  // latest attempt time.
  (update as { finished_at?: string }).finished_at = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("publish_history")
    .update(update as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", existingRow.id)
    .select("*")
    .single();
  if (updateError || !updated) {
    throw fromPostgres(updateError, "Failed to update publish history.");
  }
  return {
    action: "updated",
    entry: toEntry(updated as unknown as PublishHistoryRow),
  };
}
