import "server-only";
/**
 * Persistence for Bluesky UNFOLLOW campaigns.
 *
 * Deliberately thin. The hard machinery — atomic reservation, the
 * attempt ledger, provider-intent consumption, settlement, the sweep,
 * owned release, the dispatch lease — is campaign-kind agnostic and
 * lives in `bluesky-campaign-repository`. This module is reached for
 * only where Unfollow genuinely differs:
 *
 *   • claiming an UNFOLLOW action (which also re-checks protection,
 *     refuses a contested subject, and persists the exact record
 *     identity before anything is sent);
 *   • reading and writing the operator's "never unfollow" allowlist;
 *   • building and counting an unfollow source.
 *
 * Every function takes an explicit `workspaceId` and every query filters
 * on it. RLS also enforces membership, but the worker runs as the
 * SERVICE ROLE and bypasses policies entirely — so on the hot path the
 * filter in the query is not a second line of defence, it is the only
 * one.
 *
 * Nothing here returns "all members". The queue is built for 100,000+
 * rows and is only ever touched as a bounded keyset page, an atomically
 * claimed chunk, or an exact `head: true` count that transfers no rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import { fromPostgres } from "./errors";
import type { RecordSource } from "@/core/bluesky-unfollow/record-identity";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

/** How many source rows one import statement reads and writes. */
export const UNFOLLOW_IMPORT_CHUNK_SIZE = 500;

// =====================================================================
// The action claim — the only place an unfollow action row is created
// =====================================================================

/**
 * Permission to call `deleteRecord` for one member.
 *
 * A branded type rather than a boolean, for the reason the follow
 * subsystem learned the hard way: its verdict was three independent
 * booleans, a worker read two of them, and the combination meaning
 * "this member is not yours" fell through to the mutation path. A
 * second follow went out for a member another worker owned.
 *
 * Here the deletion function TAKES one of these. A branch that has not
 * established permission cannot call it — that is a compile error, not
 * a code review.
 */
declare const permitBrand: unique symbol;
export interface UnfollowPermit {
  readonly actionId: string;
  /** The exact record this permit authorises deleting. Nothing else. */
  readonly uri: string;
  readonly rkey: string;
  readonly cid: string | null;
  readonly [permitBrand]: true;
}

/**
 * The verdict, as a closed set.
 *
 * Seven outcomes and the caller must handle all of them; the worker's
 * switch ends in a `never` so a verdict added later cannot be silently
 * ignored.
 */
export type UnfollowClaimVerdict =
  /** This worker owns the attempt and may delete exactly this record. */
  | { kind: "may_mutate"; actionId: string; permit: UnfollowPermit }
  /** A delete MAY already have been sent. Read truth; never re-send. */
  | { kind: "reconcile_only"; actionId: string }
  | {
      kind: "terminal";
      actionId: string;
      status: "succeeded" | "failed" | "reconciliation_required";
    }
  /** Excluded by protection, re-checked just now. Carries the reason. */
  | { kind: "protected"; reason: string }
  /** Another unresolved intention exists for this identity + subject. */
  | { kind: "conflict" }
  /** No safe delete target. Signal does not guess a record key. */
  | { kind: "no_record_target"; reason: string }
  /**
   * Refused, for any other reason, or a verdict that made no sense.
   *
   * NOT reconciliation: no provider intent exists for this worker and
   * nothing was sent on its behalf, so claiming otherwise would put a
   * fiction in the operator's History. The member is left alone.
   */
  | { kind: "denied"; reason: string | null };

export interface ClaimUnfollowActionInput {
  workspaceId: string;
  campaignId: string;
  runId: string;
  memberId: string;
  operatorAccountId: string;
  subjectDid: string;
  subjectHandle: string | null;
  actorDid: string;
  actorHandle: string | null;
  /** The FRESHLY resolved record. Never a stored value on its own. */
  recordUri: string;
  recordRkey: string;
  recordCid: string | null;
  initiatedBy: string | null;
  db?: Db;
}

export async function claimUnfollowAction(
  input: ClaimUnfollowActionInput,
): Promise<UnfollowClaimVerdict> {
  const { data, error } = await client(input.db).rpc(
    "claim_bluesky_unfollow_action",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_run_id: input.runId,
      p_member_id: input.memberId,
      p_operator_account_id: input.operatorAccountId,
      p_subject_did: input.subjectDid,
      p_subject_handle: input.subjectHandle,
      p_actor_did: input.actorDid,
      p_actor_handle: input.actorHandle,
      p_record_uri: input.recordUri,
      p_record_rkey: input.recordRkey,
      p_record_cid: input.recordCid,
      p_initiated_by: input.initiatedBy,
    },
  );
  if (error) throw fromPostgres(error, "Could not claim the unfollow record.");

  const row = (Array.isArray(data) ? data[0] : data) as
    | UnfollowClaimRow
    | undefined;
  if (!row) throw fromPostgres(null, "The unfollow record could not be claimed.");
  return toUnfollowVerdict(row, input);
}

export interface UnfollowClaimRow {
  action_id: string | null;
  may_mutate: boolean | null;
  needs_reconcile: boolean | null;
  terminal: boolean | null;
  refused_reason: string | null;
  protected_reason: string | null;
  existing_status: string | null;
}

/**
 * Collapse the RPC's answer into the closed set, FAIL CLOSED.
 *
 * Order matters and is the point of the function.
 *
 *   1. An explicit refusal is honoured first, whatever else is set.
 *   2. A terminal row is terminal.
 *   3. A row that may have a request in flight is reconciliation-only.
 *   4. Permission is granted ONLY when the RPC says so AND an action id
 *      exists AND a record key exists.
 *   5. Everything left over is DENIED.
 *
 * Step 5 is the important one. The one thing worse than refusing work
 * we could have done is doing work that belongs to someone else — and
 * for a delete, "work" means permanently removing a public relationship
 * with a real person on the other end of it.
 */
export function toUnfollowVerdict(
  row: UnfollowClaimRow,
  target: { recordUri: string; recordRkey: string; recordCid: string | null },
): UnfollowClaimVerdict {
  if (row.refused_reason) {
    switch (row.refused_reason) {
      case "protected":
        return {
          kind: "protected",
          reason: row.protected_reason ?? "Protected from automatic unfollowing.",
        };
      case "conflicting_intent":
        return { kind: "conflict" };
      case "no_record_key":
      case "record_uri_mismatch":
        return {
          kind: "no_record_target",
          reason:
            row.refused_reason === "no_record_key"
              ? "No follow-record key is known for this profile, so there is nothing safe to delete."
              : "The follow record's key and address disagree, so the exact record cannot be identified.",
        };
      default:
        return { kind: "denied", reason: row.refused_reason };
    }
  }

  const actionId = row.action_id;

  if (row.terminal === true) {
    if (
      actionId &&
      (row.existing_status === "succeeded" ||
        row.existing_status === "failed" ||
        row.existing_status === "reconciliation_required")
    ) {
      return { kind: "terminal", actionId, status: row.existing_status };
    }
    // Terminal with a status we do not recognise. Refuse rather than
    // guess what a future status means for a public act.
    return { kind: "denied", reason: row.existing_status };
  }

  if (actionId && row.needs_reconcile === true) {
    return { kind: "reconcile_only", actionId };
  }

  if (actionId && row.may_mutate === true && target.recordRkey.length > 0) {
    return {
      kind: "may_mutate",
      actionId,
      permit: {
        actionId,
        uri: target.recordUri,
        rkey: target.recordRkey,
        cid: target.recordCid,
      } as UnfollowPermit,
    };
  }

  return { kind: "denied", reason: row.existing_status };
}

// =====================================================================
// The record identity a member carries
// =====================================================================

export interface MemberRecordIdentity {
  memberId: string;
  uri: string | null;
  rkey: string | null;
  cid: string | null;
  source: RecordSource | null;
}

/**
 * Read the stored record identity for a claimed chunk.
 *
 * Bounded by the chunk size (at most the manual batch maximum), so this
 * is a small `in (…)` and never a scan. The reservation RPC returns the
 * rkey but not the uri or cid, and all three are needed: the uri to
 * prove ownership, the cid for `swapRecord`.
 */
export async function getMemberRecordIdentities(input: {
  workspaceId: string;
  campaignId: string;
  memberIds: string[];
  db?: Db;
}): Promise<Map<string, MemberRecordIdentity>> {
  const out = new Map<string, MemberRecordIdentity>();
  if (input.memberIds.length === 0) return out;

  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .select(
      "id, provider_record_uri, provider_record_rkey, provider_record_cid, provider_record_source",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .in("id", input.memberIds);
  if (error) throw fromPostgres(error, "Could not read the follow records.");

  for (const row of (data ?? []) as unknown as {
    id: string;
    provider_record_uri: string | null;
    provider_record_rkey: string | null;
    provider_record_cid: string | null;
    provider_record_source: RecordSource | null;
  }[]) {
    out.set(row.id, {
      memberId: row.id,
      uri: row.provider_record_uri,
      rkey: row.provider_record_rkey,
      cid: row.provider_record_cid,
      source: row.provider_record_source,
    });
  }
  return out;
}

/** Persist a freshly-resolved record identity onto the member row. */
export async function setMemberRecordIdentity(input: {
  workspaceId: string;
  memberId: string;
  uri: string;
  rkey: string;
  cid: string | null;
  source: RecordSource;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .update({
      provider_record_uri: input.uri,
      provider_record_rkey: input.rkey,
      provider_record_cid: input.cid,
      provider_record_source: input.source,
    })
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.memberId);
  if (error) throw fromPostgres(error, "Could not record the follow record.");
}

/** Mark a member protected, with the reason the database gave. */
export async function markMemberProtected(input: {
  workspaceId: string;
  memberId: string;
  reason: string;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .update({
      status: "protected",
      protected_reason: input.reason,
      completed_at: new Date().toISOString(),
      claimed_at: null,
      claimed_by: null,
      lease_expires_at: null,
    })
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.memberId);
  if (error) throw fromPostgres(error, "Could not record the protection.");
}

// =====================================================================
// The "never unfollow" allowlist
// =====================================================================

export interface AllowlistEntry {
  id: string;
  subjectDid: string;
  subjectHandle: string | null;
  operatorAccountId: string | null;
  reason: string | null;
  createdAt: string;
}

export async function listAllowlist(input: {
  workspaceId: string;
  db?: Db;
}): Promise<AllowlistEntry[]> {
  const { data, error } = await client(input.db)
    .from("bluesky_unfollow_allowlist")
    .select("id, subject_did, subject_handle_at_add, operator_account_id, reason, created_at")
    .eq("workspace_id", input.workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw fromPostgres(error, "Could not read the never-unfollow list.");
  return ((data ?? []) as unknown as {
    id: string;
    subject_did: string;
    subject_handle_at_add: string | null;
    operator_account_id: string | null;
    reason: string | null;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    subjectDid: r.subject_did,
    subjectHandle: r.subject_handle_at_add,
    operatorAccountId: r.operator_account_id,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export async function addToAllowlist(input: {
  workspaceId: string;
  operatorAccountId: string | null;
  subjectDid: string;
  subjectHandle: string | null;
  reason: string | null;
  addedBy: string | null;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_unfollow_allowlist")
    .upsert(
      {
        workspace_id: input.workspaceId,
        operator_account_id: input.operatorAccountId,
        subject_did: input.subjectDid,
        subject_handle_at_add: input.subjectHandle,
        reason: input.reason,
        added_by: input.addedBy,
      },
      {
        onConflict: input.operatorAccountId
          ? "workspace_id,operator_account_id,subject_did"
          : "workspace_id,subject_did",
        ignoreDuplicates: false,
      },
    );
  if (error) throw fromPostgres(error, "Could not add to the never-unfollow list.");
}

export async function removeFromAllowlist(input: {
  workspaceId: string;
  entryId: string;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_unfollow_allowlist")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.entryId);
  if (error) throw fromPostgres(error, "Could not remove from the never-unfollow list.");
}

// =====================================================================
// Sources
// =====================================================================

export type UnfollowSourceKind =
  | "following_records"
  | "target_followers"
  | "follow_campaign"
  | "filtered_candidates";

export interface SourceCounts {
  eligible: number;
  protectedExcluded: number;
}

/**
 * Count a source WITHOUT reading it into memory.
 *
 * The operator is shown an exact number before committing, and that
 * number has to be right for a 100,000-row list — so it is a database
 * count, never the length of something fetched.
 *
 * `following_records` is absent on purpose: the acting repository can
 * only be counted by walking it at the provider, which is what the
 * queue build itself does. The setup screen says "still counting" for
 * that scope rather than inventing a number.
 */
export async function countSource(input: {
  workspaceId: string;
  operatorAccountId: string;
  actorDid: string;
  sourceKind: Exclude<UnfollowSourceKind, "following_records">;
  targetProfileId: string | null;
  sourceCampaignId: string | null;
  db?: Db;
}): Promise<SourceCounts> {
  const { data, error } = await client(input.db).rpc(
    "count_bluesky_unfollow_source",
    {
      p_workspace_id: input.workspaceId,
      p_operator_account_id: input.operatorAccountId,
      p_actor_did: input.actorDid,
      p_source_kind:
        input.sourceKind === "filtered_candidates"
          ? "filtered_candidates"
          : input.sourceKind,
      p_target_profile_id: input.targetProfileId,
      p_source_campaign_id: input.sourceCampaignId,
    },
  );
  if (error) throw fromPostgres(error, "Could not count that list.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { eligible: number; protected_excluded: number }
    | undefined;
  return {
    eligible: Number(row?.eligible ?? 0),
    protectedExcluded: Number(row?.protected_excluded ?? 0),
  };
}

export interface SourceRow {
  subjectDid: string;
  currentHandle: string | null;
  displayName: string | null;
  recordUri: string | null;
  recordRkey: string | null;
  recordCid: string | null;
}

/**
 * One keyset page of a database-backed source.
 *
 * Ordered by `subject_did` alone — a total order whose tie-breaker IS
 * the key, so no two rows can tie and no row can move across the cursor
 * mid-walk. There is no OFFSET: the cost is the same at row 1 and row
 * 100,000, and a row changing state cannot make the walk skip another.
 */
export async function listSourcePage(input: {
  workspaceId: string;
  operatorAccountId: string;
  sourceKind: Exclude<UnfollowSourceKind, "following_records">;
  targetProfileId: string | null;
  sourceCampaignId: string | null;
  afterDid: string | null;
  limit: number;
  db?: Db;
}): Promise<SourceRow[]> {
  const { data, error } = await client(input.db).rpc(
    "list_bluesky_unfollow_source_keyset",
    {
      p_workspace_id: input.workspaceId,
      p_operator_account_id: input.operatorAccountId,
      p_source_kind: input.sourceKind,
      p_target_profile_id: input.targetProfileId,
      p_source_campaign_id: input.sourceCampaignId,
      p_after_did: input.afterDid,
      p_limit: input.limit,
    },
  );
  if (error) throw fromPostgres(error, "Could not read the list.");
  return ((data ?? []) as unknown as {
    subject_did: string;
    current_handle: string | null;
    display_name: string | null;
    record_uri: string | null;
    record_rkey: string | null;
    record_cid: string | null;
  }[]).map((r) => ({
    subjectDid: r.subject_did,
    currentHandle: r.current_handle,
    displayName: r.display_name,
    recordUri: r.record_uri,
    recordRkey: r.record_rkey,
    recordCid: r.record_cid,
  }));
}

export interface ImportChunkResult {
  inserted: number;
  duplicates: number;
  protectedCount: number;
  lastDid: string | null;
}

export interface ImportMemberRow {
  subject_did: string;
  current_handle: string | null;
  display_name: string | null;
  record_uri: string | null;
  record_rkey: string | null;
  record_cid: string | null;
  record_source: RecordSource;
}

/** Write one bounded chunk into the frozen queue. */
export async function importUnfollowChunk(input: {
  workspaceId: string;
  campaignId: string;
  operatorAccountId: string;
  actorDid: string;
  members: ImportMemberRow[];
  db?: Db;
}): Promise<ImportChunkResult> {
  const { data, error } = await client(input.db).rpc(
    "import_bluesky_unfollow_member_chunk",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_operator_account_id: input.operatorAccountId,
      p_actor_did: input.actorDid,
      p_members: input.members,
    },
  );
  if (error) throw fromPostgres(error, "Could not add profiles to the list.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_inserted: number;
        out_duplicates: number;
        out_protected: number;
        out_last_did: string | null;
      }
    | undefined;
  return {
    inserted: Number(row?.out_inserted ?? 0),
    duplicates: Number(row?.out_duplicates ?? 0),
    protectedCount: Number(row?.out_protected ?? 0),
    lastDid: row?.out_last_did ?? null,
  };
}

// =====================================================================
// Cancellation
// =====================================================================

/**
 * Stop future work.
 *
 * Never re-follows anyone, never rewrites an action row, and never
 * marks a member with outstanding provider intent as cancelled — that
 * member's outcome is unknown, which is a different thing from absent.
 */
export async function cancelFutureWork(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<{ cancelledMembers: number; leftUnresolved: number }> {
  const { data, error } = await client(input.db).rpc(
    "cancel_bluesky_campaign_future_work",
    { p_workspace_id: input.workspaceId, p_campaign_id: input.campaignId },
  );
  if (error) throw fromPostgres(error, "Could not cancel the campaign.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { cancelled_members: number; left_unresolved: number }
    | undefined;
  return {
    cancelledMembers: Number(row?.cancelled_members ?? 0),
    leftUnresolved: Number(row?.left_unresolved ?? 0),
  };
}

// =====================================================================
// The neutral success
// =====================================================================

export type AlreadyAbsentResult =
  | { kind: "already_not_following"; actionId: string | null }
  | { kind: "protected"; reason: string }
  | { kind: "refused"; reason: string };

/**
 * Record a member the provider says is not followed.
 *
 * Also finalises the audit row, which is the part that matters: a
 * worker killed mid-delete leaves one marked in flight, and a pass that
 * short-circuits here without touching it would leave the member
 * looking finished while History says a request is still outstanding.
 */
export async function recordAlreadyAbsent(input: {
  workspaceId: string;
  campaignId: string;
  runId: string;
  memberId: string;
  operatorAccountId: string;
  subjectDid: string;
  subjectHandle: string | null;
  actorDid: string;
  actorHandle: string | null;
  initiatedBy: string | null;
  note?: string | null;
  db?: Db;
}): Promise<AlreadyAbsentResult> {
  const { data, error } = await client(input.db).rpc(
    "record_bluesky_unfollow_already_absent",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_run_id: input.runId,
      p_member_id: input.memberId,
      p_operator_account_id: input.operatorAccountId,
      p_subject_did: input.subjectDid,
      p_subject_handle: input.subjectHandle,
      p_actor_did: input.actorDid,
      p_actor_handle: input.actorHandle,
      p_initiated_by: input.initiatedBy,
      p_note: input.note ?? null,
    },
  );
  if (error) throw fromPostgres(error, "Could not record the result.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        recorded: string;
        protected_reason: string | null;
        refused_reason: string | null;
        action_id: string | null;
      }
    | undefined;
  if (row?.recorded === "protected") {
    return {
      kind: "protected",
      reason: row.protected_reason ?? "Protected from automatic unfollowing.",
    };
  }
  if (row?.recorded === "already_not_following") {
    return { kind: "already_not_following", actionId: row.action_id };
  }
  return { kind: "refused", reason: row?.refused_reason ?? "unknown" };
}

export { deferMember } from "./bluesky-campaign-repository";
