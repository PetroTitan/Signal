import "server-only";
/**
 * Account-level context persistence.
 *
 * CADENCE DECISION
 * ----------------
 * Snapshots are bucketed by DAY, not by hour and not per sweep.
 *
 * Follower counts move slowly — the accounts in question moved by single
 * digits over three months — so a finer bucket would spend provider
 * requests to record the same number repeatedly, and on X those requests
 * are billable. A day is fine enough to show growth against a publishing
 * campaign and coarse enough to cost almost nothing.
 *
 * The bucket is encoded in `source`, which the table's
 * `unique (account_id, source)` constraint then makes idempotent for
 * free: a sweep that runs twice in a day writes one history row. This is
 * deliberately the same trick `post_metrics` uses for its hour buckets,
 * so there is one convention in the codebase rather than two.
 *
 * Two rows exist per account:
 *   canonical  source = "<provider_source>"                  latest state
 *   history    source = "snapshot:<provider_source>:<date>"  immutable point
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountSnapshotInsert,
  AccountSnapshotRow,
  MetricFreshness,
} from "@/lib/supabase/types";
import type { AccountSnapshot } from "@/core/metrics/account-context";
import { fromPostgres } from "./errors";

export const ACCOUNT_SNAPSHOT_PREFIX = "snapshot:";

/** Day bucket — one immutable history row per account per calendar day. */
export function accountSnapshotSource(
  providerSource: string,
  fetchedAtIso: string,
): string {
  return `${ACCOUNT_SNAPSHOT_PREFIX}${providerSource}:${fetchedAtIso.slice(0, 10)}`;
}

export function isAccountSnapshotHistory(source: string): boolean {
  return source.startsWith(ACCOUNT_SNAPSHOT_PREFIX);
}

export interface PersistAccountSnapshotInput {
  workspaceId: string;
  accountId: string;
  snapshot: AccountSnapshot;
  freshness?: MetricFreshness;
  error?: string | null;
  db: SupabaseClient;
}

export interface PersistAccountSnapshotResult {
  canonicalWritten: boolean;
  historyWritten: boolean;
  error: string | null;
}

/**
 * Write one account snapshot.
 *
 * NEVER throws: an account-context failure must not discard the post
 * measurements the same sweep just wrote. The caller gets a result it can
 * count rather than an exception it has to catch.
 *
 * Counts stay NULL when the provider did not report them. A provider
 * that omits `followersCount` has not told us there are zero followers.
 */
export async function persistAccountSnapshot(
  input: PersistAccountSnapshotInput,
): Promise<PersistAccountSnapshotResult> {
  const { snapshot, db } = input;

  const base: AccountSnapshotInsert = {
    workspace_id: input.workspaceId,
    account_id: input.accountId,
    platform: snapshot.platform,
    provider_account_id: snapshot.providerAccountId,
    handle: snapshot.handle || null,
    followers: snapshot.followers,
    following: snapshot.following,
    post_count: snapshot.postCount,
    provider_created_at: snapshot.createdAt,
    source: snapshot.source,
    freshness: input.freshness ?? "fresh",
    error: input.error ?? null,
    fetched_at: snapshot.fetchedAt,
  };

  const { error: canonicalError } = await db
    .from("account_snapshots")
    .upsert(base as never, { onConflict: "account_id,source" });
  if (canonicalError) {
    console.error(
      "[account-snapshot] canonical write failed (non-fatal)",
      canonicalError.message,
    );
    return { canonicalWritten: false, historyWritten: false, error: canonicalError.message };
  }

  const { error: historyError } = await db.from("account_snapshots").upsert(
    {
      ...base,
      source: accountSnapshotSource(snapshot.source, snapshot.fetchedAt),
    } as never,
    { onConflict: "account_id,source", ignoreDuplicates: true },
  );
  if (historyError) {
    // The canonical row landed; losing the history point is degraded, not
    // failed, and saying so is more useful than reporting a total failure.
    console.error(
      "[account-snapshot] history write failed (non-fatal)",
      historyError.message,
    );
    return { canonicalWritten: true, historyWritten: false, error: historyError.message };
  }

  return { canonicalWritten: true, historyWritten: true, error: null };
}

/**
 * Record that an account COULD NOT be read.
 *
 * Without this, a provider outage looks identical to an account that was
 * never collected. The row carries null counts and a non-fresh state, so
 * nothing downstream can mistake it for data.
 */
export async function persistAccountSnapshotFailure(input: {
  workspaceId: string;
  accountId: string;
  platform: string;
  source: string;
  freshness: MetricFreshness;
  error: string;
  fetchedAtIso: string;
  db: SupabaseClient;
}): Promise<{ recorded: boolean }> {
  const row: AccountSnapshotInsert = {
    workspace_id: input.workspaceId,
    account_id: input.accountId,
    platform: input.platform,
    followers: null,
    following: null,
    post_count: null,
    source: input.source,
    freshness: input.freshness,
    error: input.error.slice(0, 300),
    fetched_at: input.fetchedAtIso,
  };
  const { error } = await input.db
    .from("account_snapshots")
    .upsert(row as never, { onConflict: "account_id,source" });
  if (error) {
    console.error("[account-snapshot] failure write failed", error.message);
    return { recorded: false };
  }
  return { recorded: true };
}

export interface AccountSnapshotRecord {
  accountId: string;
  platform: string;
  handle: string | null;
  providerAccountId: string | null;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  providerCreatedAt: string | null;
  fetchedAt: string;
  source: string;
  freshness: MetricFreshness;
  error: string | null;
}

function toRecord(row: AccountSnapshotRow): AccountSnapshotRecord {
  return {
    accountId: row.account_id,
    platform: row.platform,
    handle: row.handle,
    providerAccountId: row.provider_account_id,
    followers: row.followers,
    following: row.following,
    postCount: row.post_count,
    providerCreatedAt: row.provider_created_at,
    fetchedAt: row.fetched_at,
    source: row.source,
    freshness: row.freshness,
    error: row.error,
  };
}

/** Latest canonical snapshot per account in a workspace. */
export async function listLatestAccountSnapshots(
  workspaceId: string,
  db: SupabaseClient,
): Promise<Map<string, AccountSnapshotRecord>> {
  const { data, error } = await db
    .from("account_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("fetched_at", { ascending: false })
    .limit(500);
  if (error) throw fromPostgres(error, "Failed to read account snapshots.");

  const out = new Map<string, AccountSnapshotRecord>();
  for (const row of (data ?? []) as unknown as AccountSnapshotRow[]) {
    if (isAccountSnapshotHistory(row.source)) continue;
    if (!out.has(row.account_id)) out.set(row.account_id, toRecord(row));
  }
  return out;
}

/**
 * Which accounts are due a snapshot.
 *
 * PURE, so the cadence rule is testable without a database. An account is
 * due when it has never been snapshotted, or its newest snapshot falls in
 * an earlier day bucket than now.
 */
export function accountsDueForSnapshot<T extends { accountId: string }>(
  accounts: readonly T[],
  latest: ReadonlyMap<string, { fetchedAt: string }>,
  nowIso: string,
): T[] {
  const today = nowIso.slice(0, 10);
  return accounts.filter((account) => {
    const last = latest.get(account.accountId);
    if (!last) return true;
    return last.fetchedAt.slice(0, 10) < today;
  });
}
