import "server-only";
/**
 * Persistence for Bluesky follow campaigns.
 *
 * Every function takes an explicit `workspaceId` and every query filters
 * on it. RLS also enforces membership, but the worker runs as the
 * SERVICE ROLE and bypasses policies entirely — so for this subsystem
 * the filter in the query is not a second line of defence, it is the
 * only one on the hot path.
 *
 * SCALE DISCIPLINE
 * ----------------
 * Nothing here loads a campaign into memory. The queue is designed for
 * 100,000+ members and is only ever touched as:
 *
 *   - a bounded page, ordered by `import_sequence` with `id` as the
 *     unique tiebreaker (keyset, never OFFSET);
 *   - an atomically claimed chunk, via the claiming RPC;
 *   - an exact `count: "exact", head: true` that transfers no rows.
 *
 * There is no function that returns "all members", and no call site
 * that could ask for one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  BlueskyCampaignKillSwitchRow,
  BlueskyCampaignMemberStatus,
  BlueskyCampaignRunStatus,
  BlueskyCampaignStatus,
  BlueskyFollowCampaignMemberRow,
  BlueskyFollowCampaignRow,
  BlueskyFollowCampaignRunRow,
  BlueskyIdentityDailyUsageRow,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

/** UI page size. Small on purpose: a 100k queue is never scrolled. */
export const CAMPAIGN_MEMBER_PAGE_SIZE = 50;
export const CAMPAIGN_RUN_PAGE_SIZE = 20;

/** How many rows one import statement writes. Bounded, streamed. */
export const IMPORT_CHUNK_SIZE = 500;

export interface PageInfo {
  page: number;
  pageSize: number;
  /** Exact, from Postgres. Never derived from the current page. */
  total: number;
  totalPages: number;
}

// =====================================================================
// Campaigns
// =====================================================================

export async function createCampaign(input: {
  workspaceId: string;
  operatorAccountId: string;
  name: string;
  requestedDailyQuota: number;
  timezone: string;
  windowStartMinute: number;
  windowEndMinute: number;
  startDate: string | null;
  dryRun: boolean;
  createdBy: string | null;
  db?: Db;
}): Promise<BlueskyFollowCampaignRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaigns")
    .insert({
      workspace_id: input.workspaceId,
      operator_account_id: input.operatorAccountId,
      name: input.name,
      status: "draft",
      requested_daily_quota: input.requestedDailyQuota,
      timezone: input.timezone,
      execution_window_start_minute: input.windowStartMinute,
      execution_window_end_minute: input.windowEndMinute,
      start_date: input.startDate,
      dry_run: input.dryRun,
      created_by: input.createdBy,
    } as never)
    .select("*")
    .single();
  if (error) throw fromPostgres(error, "Could not create the campaign.");
  return data as unknown as BlueskyFollowCampaignRow;
}

export async function getCampaign(
  workspaceId: string,
  campaignId: string,
  db?: Db,
): Promise<BlueskyFollowCampaignRow | null> {
  const { data, error } = await client(db)
    .from("bluesky_follow_campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the campaign.");
  return (data as unknown as BlueskyFollowCampaignRow) ?? null;
}

export async function listCampaigns(
  workspaceId: string,
  limit = 50,
  db?: Db,
): Promise<BlueskyFollowCampaignRow[]> {
  const { data, error } = await client(db)
    .from("bluesky_follow_campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Could not list campaigns.");
  return (data ?? []) as unknown as BlueskyFollowCampaignRow[];
}

export interface UpdateCampaignInput {
  workspaceId: string;
  campaignId: string;
  status?: BlueskyCampaignStatus;
  requestedDailyQuota?: number;
  nextRunAt?: string | null;
  activatedAt?: string | null;
  completedAt?: string | null;
  pausedAt?: string | null;
  cancelledAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  rateLimitedUntil?: string | null;
  /**
   * Only apply when the campaign is still in one of these statuses.
   * A compare-and-set guard: two workers reaching a terminal transition
   * at the same time must not both "complete" the campaign.
   */
  expectedStatuses?: BlueskyCampaignStatus[];
  db?: Db;
}

export async function updateCampaign(
  input: UpdateCampaignInput,
): Promise<BlueskyFollowCampaignRow | null> {
  const patch: Record<string, unknown> = {};
  const set = <K extends keyof UpdateCampaignInput>(key: K, column: string) => {
    if (input[key] !== undefined) patch[column] = input[key];
  };
  set("status", "status");
  set("requestedDailyQuota", "requested_daily_quota");
  set("nextRunAt", "next_run_at");
  set("activatedAt", "activated_at");
  set("completedAt", "completed_at");
  set("pausedAt", "paused_at");
  set("cancelledAt", "cancelled_at");
  set("lastErrorCode", "last_error_code");
  set("lastErrorMessage", "last_error_message");
  set("rateLimitedUntil", "rate_limited_until");

  let query = client(input.db)
    .from("bluesky_follow_campaigns")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.campaignId);
  if (input.expectedStatuses && input.expectedStatuses.length > 0) {
    query = query.in("status", input.expectedStatuses);
  }

  const { data, error } = await query.select("*");
  if (error) throw fromPostgres(error, "Could not update the campaign.");
  const rows = (data ?? []) as unknown as BlueskyFollowCampaignRow[];
  // Zero rows means the guard did not hold — the caller must treat that
  // as "someone else moved it", not as success.
  return rows[0] ?? null;
}

/** Campaigns the dispatcher should look at. Workspace-wide by design. */
export async function listDueCampaigns(input: {
  nowIso: string;
  limit?: number;
  db?: Db;
}): Promise<BlueskyFollowCampaignRow[]> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaigns")
    .select("*")
    .eq("status", "active")
    // `next_run_at` is a hint, not a promise: a null means "look now".
    .or(`next_run_at.is.null,next_run_at.lte.${input.nowIso}`)
    .order("next_run_at", { ascending: true })
    .limit(input.limit ?? 25);
  if (error) throw fromPostgres(error, "Could not list due campaigns.");
  return (data ?? []) as unknown as BlueskyFollowCampaignRow[];
}

// =====================================================================
// Members
// =====================================================================

export interface ImportMemberInput {
  subjectDid: string;
  currentHandle: string | null;
  displayName: string | null;
  /** Target profile this DID came from, when it came from one. */
  targetProfileId?: string | null;
  sourceLabel?: string;
}

export interface ImportResult {
  inserted: number;
  duplicates: number;
  /** The highest import_sequence now in the campaign. */
  lastSequence: number;
}

/**
 * The next import sequence for a campaign.
 *
 * One indexed row read (`order by import_sequence desc limit 1`), not a
 * count and not a scan — this has to stay constant-time at 100,000 rows.
 */
export async function nextImportSequence(
  workspaceId: string,
  campaignId: string,
  db?: Db,
): Promise<number> {
  const { data, error } = await client(db)
    .from("bluesky_follow_campaign_members")
    .select("import_sequence")
    .eq("workspace_id", workspaceId)
    .eq("campaign_id", campaignId)
    .order("import_sequence", { ascending: false })
    .limit(1);
  if (error) throw fromPostgres(error, "Could not read the import sequence.");
  const rows = (data ?? []) as unknown as { import_sequence: number }[];
  return rows.length === 0 ? 1 : Number(rows[0].import_sequence) + 1;
}

/**
 * Import one bounded chunk of members.
 *
 * Deduplication is the database's `unique (campaign_id, subject_did)`,
 * not an in-memory Set — a Set only dedupes within one call, and a
 * 100,000-member import is hundreds of calls that may overlap.
 *
 * `ignoreDuplicates` means a DID already in the campaign keeps its
 * original `import_sequence` and its progress. Re-importing an
 * overlapping audience is therefore safe and cheap, and it never
 * reshuffles the queue under a running campaign.
 */
export async function importMemberChunk(input: {
  workspaceId: string;
  campaignId: string;
  members: ImportMemberInput[];
  startSequence: number;
  db?: Db;
}): Promise<ImportResult> {
  if (input.members.length === 0) {
    return { inserted: 0, duplicates: 0, lastSequence: input.startSequence - 1 };
  }
  const supabase = client(input.db);

  // Collapse duplicates WITHIN this chunk first, so two copies of one
  // DID in the same page do not consume two sequence numbers.
  const unique = new Map<string, ImportMemberInput>();
  for (const m of input.members) {
    if (!m.subjectDid.startsWith("did:")) continue;
    const existing = unique.get(m.subjectDid);
    if (existing) continue;
    unique.set(m.subjectDid, m);
  }

  let sequence = input.startSequence;
  const payload = [...unique.values()].map((m) => ({
    workspace_id: input.workspaceId,
    campaign_id: input.campaignId,
    subject_did: m.subjectDid,
    current_handle: m.currentHandle,
    display_name: m.displayName,
    import_sequence: sequence++,
    status: "queued" as const,
  }));

  const { data, error } = await supabase
    .from("bluesky_follow_campaign_members")
    .upsert(payload as never, {
      onConflict: "campaign_id,subject_did",
      // A DID already queued keeps its sequence and its progress.
      ignoreDuplicates: true,
    })
    .select("id, subject_did");
  if (error) throw fromPostgres(error, "Could not import campaign members.");

  const insertedRows = (data ?? []) as unknown as {
    id: string;
    subject_did: string;
  }[];

  // Attribution for every DID in the chunk — including ones that were
  // already members. A DID discovered under a second target GAINS a
  // source row; it never replaces the first.
  await recordMemberSources({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    members: [...unique.values()],
    db: input.db,
  });

  return {
    inserted: insertedRows.length,
    duplicates: unique.size - insertedRows.length,
    lastSequence: sequence - 1,
  };
}

/**
 * Record where each DID came from.
 *
 * A join table, not an array column, for the same reason as
 * `bluesky_candidate_sources`: an array is read-modify-written and two
 * concurrent imports of overlapping audiences lose one attribution.
 */
async function recordMemberSources(input: {
  workspaceId: string;
  campaignId: string;
  members: ImportMemberInput[];
  db?: Db;
}): Promise<void> {
  const withSource = input.members.filter(
    (m) => m.targetProfileId || m.sourceLabel,
  );
  if (withSource.length === 0) return;
  const supabase = client(input.db);

  // Resolve member ids for this chunk's DIDs. Bounded by the chunk.
  const { data, error } = await supabase
    .from("bluesky_follow_campaign_members")
    .select("id, subject_did")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .in(
      "subject_did",
      withSource.map((m) => m.subjectDid),
    );
  if (error) throw fromPostgres(error, "Could not resolve member ids.");
  const idByDid = new Map(
    ((data ?? []) as unknown as { id: string; subject_did: string }[]).map((r) => [
      r.subject_did,
      r.id,
    ]),
  );

  const rows = withSource
    .map((m) => {
      const memberId = idByDid.get(m.subjectDid);
      if (!memberId) return null;
      return {
        workspace_id: input.workspaceId,
        member_id: memberId,
        target_profile_id: m.targetProfileId ?? null,
        source_label: m.sourceLabel ?? "import",
        last_seen_at: new Date().toISOString(),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return;

  const { error: sourceError } = await supabase
    .from("bluesky_campaign_member_sources")
    .upsert(rows as never, {
      onConflict: "member_id,target_profile_id,source_label",
      ignoreDuplicates: true,
    });
  if (sourceError) {
    throw fromPostgres(sourceError, "Could not record member attribution.");
  }
}

export interface MemberPage {
  rows: BlueskyFollowCampaignMemberRow[];
  info: PageInfo;
}

/**
 * One page of members.
 *
 * Ordered by `import_sequence` with `id` as the unique tiebreaker.
 * Thousands of rows share a `created_at` to the millisecond in a bulk
 * import, so ordering on a timestamp would leave ties undefined between
 * requests — a row appearing on two pages and on none. `import_sequence`
 * is unique per campaign by constraint, so the order is total.
 */
export async function listMembersPage(input: {
  workspaceId: string;
  campaignId: string;
  statuses?: BlueskyCampaignMemberStatus[];
  search?: string;
  page?: number;
  pageSize?: number;
  db?: Db;
}): Promise<MemberPage> {
  const supabase = client(input.db);
  const pageSize = Math.min(
    Math.max(input.pageSize ?? CAMPAIGN_MEMBER_PAGE_SIZE, 1),
    200,
  );
  const page = Math.max(input.page ?? 1, 1);
  const from = (page - 1) * pageSize;

  const applyFilters = (q: FilteredQuery): FilteredQuery => {
    let out = q
      .eq("workspace_id", input.workspaceId)
      .eq("campaign_id", input.campaignId);
    if (input.statuses && input.statuses.length > 0) {
      out = out.in("status", input.statuses);
    }
    const term = input.search?.trim();
    if (term) {
      const like = `%${term}%`;
      out = out.or(`current_handle.ilike.${like},display_name.ilike.${like}`);
    }
    return out;
  };

  const { count, error: countError } = await applyFilters(
    asFiltered(
      supabase
        .from("bluesky_follow_campaign_members")
        .select("id", { count: "exact", head: true }),
    ),
  );
  if (countError) throw fromPostgres(countError, "Could not count members.");
  const total = count ?? 0;

  const { data, error } = await applyFilters(
    asFiltered(supabase.from("bluesky_follow_campaign_members").select("*")),
  )
    .order("import_sequence", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) throw fromPostgres(error, "Could not list members.");

  return {
    rows: (data ?? []) as unknown as BlueskyFollowCampaignMemberRow[],
    info: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export interface MemberStatusCounts {
  total: number;
  queued: number;
  claimed: number;
  running: number;
  succeeded: number;
  already_following: number;
  protected: number;
  skipped: number;
  retryable: number;
  failed_structural: number;
  cancelled: number;
  /** queued + retryable — what could still be attempted. */
  remainingEligible: number;
}

/**
 * Exact per-status counts.
 *
 * One `head: true` count per status rather than a GROUP BY, because
 * PostgREST cannot group without a database function and each of these
 * is an index-only count that transfers no rows. Ten cheap round trips
 * in parallel, rather than one expensive scan of 100,000 rows.
 */
export async function countMembersByStatus(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<MemberStatusCounts> {
  const supabase = client(input.db);
  const countWhere = async (
    status?: BlueskyCampaignMemberStatus,
  ): Promise<number> => {
    let q = asFiltered(
      supabase
        .from("bluesky_follow_campaign_members")
        .select("id", { count: "exact", head: true }),
    )
      .eq("workspace_id", input.workspaceId)
      .eq("campaign_id", input.campaignId);
    if (status) q = q.eq("status", status);
    const { count, error } = await q;
    if (error) throw fromPostgres(error, "Could not count members.");
    return count ?? 0;
  };

  const [
    total,
    queued,
    claimed,
    running,
    succeeded,
    alreadyFollowing,
    protectedCount,
    skipped,
    retryable,
    failedStructural,
    cancelled,
  ] = await Promise.all([
    countWhere(),
    countWhere("queued"),
    countWhere("claimed"),
    countWhere("running"),
    countWhere("succeeded"),
    countWhere("already_following"),
    countWhere("protected"),
    countWhere("skipped"),
    countWhere("retryable"),
    countWhere("failed_structural"),
    countWhere("cancelled"),
  ]);

  return {
    total,
    queued,
    claimed,
    running,
    succeeded,
    already_following: alreadyFollowing,
    protected: protectedCount,
    skipped,
    retryable,
    failed_structural: failedStructural,
    cancelled,
    remainingEligible: queued + retryable,
  };
}

export interface UpdateMemberInput {
  workspaceId: string;
  memberId: string;
  status: BlueskyCampaignMemberStatus;
  attemptCount?: number;
  nextAttemptAt?: string | null;
  providerRecordUri?: string | null;
  providerRecordRkey?: string | null;
  providerRecordCid?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastAttemptedAt?: string | null;
  completedAt?: string | null;
  currentHandle?: string | null;
  db?: Db;
}

/**
 * Write a member's outcome.
 *
 * Always clears the lease. A row that reaches any terminal state must
 * not keep `claimed_at` / `lease_expires_at`, or the claiming RPC's
 * expired-lease branch could pick it up again.
 */
export async function updateMember(input: UpdateMemberInput): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    claimed_at: null,
    claimed_by: null,
    lease_expires_at: null,
  };
  const set = <K extends keyof UpdateMemberInput>(key: K, column: string) => {
    if (input[key] !== undefined) patch[column] = input[key];
  };
  set("attemptCount", "attempt_count");
  set("nextAttemptAt", "next_attempt_at");
  set("providerRecordUri", "provider_record_uri");
  set("providerRecordRkey", "provider_record_rkey");
  set("providerRecordCid", "provider_record_cid");
  set("lastErrorCode", "last_error_code");
  set("lastErrorMessage", "last_error_message");
  set("lastAttemptedAt", "last_attempted_at");
  set("completedAt", "completed_at");
  set("currentHandle", "current_handle");

  const { error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.memberId);
  if (error) throw fromPostgres(error, "Could not update the member.");
}

// =====================================================================
// Atomic claiming — the RPCs
// =====================================================================

/**
 * Atomically lease a bounded chunk.
 *
 * The atomicity lives in the RPC (`FOR UPDATE SKIP LOCKED`), not here.
 * This is the typed wrapper; it adds the workspace scope as an argument
 * because the worker runs as the service role and has no RLS context.
 */
export async function claimMembers(input: {
  workspaceId: string;
  campaignId: string;
  chunkSize: number;
  leaseSeconds: number;
  claimedBy: string;
  db?: Db;
}): Promise<BlueskyFollowCampaignMemberRow[]> {
  const { data, error } = await client(input.db).rpc(
    "claim_bluesky_campaign_members",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_chunk_size: input.chunkSize,
      p_lease_seconds: input.leaseSeconds,
      p_claimed_by: input.claimedBy,
    },
  );
  if (error) throw fromPostgres(error, "Could not claim campaign members.");
  return (data ?? []) as unknown as BlueskyFollowCampaignMemberRow[];
}

/** Return untouched leased rows to the queue without spending an attempt. */
export async function releaseMembers(input: {
  workspaceId: string;
  campaignId: string;
  memberIds: string[];
  db?: Db;
}): Promise<number> {
  if (input.memberIds.length === 0) return 0;
  const { data, error } = await client(input.db).rpc(
    "release_bluesky_campaign_members",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_member_ids: input.memberIds,
    },
  );
  if (error) throw fromPostgres(error, "Could not release campaign members.");
  return Number(data ?? 0);
}

// =====================================================================
// Daily runs
// =====================================================================

/**
 * Get or create today's run.
 *
 * Idempotent by construction: Vercel Cron is at-least-once, and the
 * unique index on (campaign_id, local_date) plus ON CONFLICT DO NOTHING
 * means a duplicate delivery re-selects the existing run rather than
 * creating a second one or erroring.
 */
export async function ensureRun(input: {
  workspaceId: string;
  campaignId: string;
  localDate: string;
  requestedQuota: number;
  effectiveQuota: number;
  effectiveReason: string | null;
  db?: Db;
}): Promise<BlueskyFollowCampaignRunRow> {
  const { data, error } = await client(input.db).rpc(
    "ensure_bluesky_campaign_run",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_local_date: input.localDate,
      p_requested_quota: input.requestedQuota,
      p_effective_quota: input.effectiveQuota,
      p_effective_reason: input.effectiveReason,
    },
  );
  if (error) throw fromPostgres(error, "Could not start the daily run.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | BlueskyFollowCampaignRunRow
    | undefined;
  if (!row) throw fromPostgres(null, "Daily run could not be resolved.");
  return row;
}

export async function getRun(
  workspaceId: string,
  runId: string,
  db?: Db,
): Promise<BlueskyFollowCampaignRunRow | null> {
  const { data, error } = await client(db)
    .from("bluesky_follow_campaign_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the run.");
  return (data as unknown as BlueskyFollowCampaignRunRow) ?? null;
}

export async function updateRun(input: {
  workspaceId: string;
  runId: string;
  status?: BlueskyCampaignRunStatus;
  effectiveDailyQuota?: number;
  effectiveQuotaReason?: string | null;
  attemptedCount?: number;
  succeededCount?: number;
  alreadyFollowingCount?: number;
  skippedCount?: number;
  failedCount?: number;
  consecutiveFailures?: number;
  rateLimitedUntil?: string | null;
  rateLimitRemaining?: number | null;
  rateLimitResetAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  completedAt?: string | null;
  lastChunkAt?: string | null;
  db?: Db;
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  const set = <K extends keyof typeof input>(key: K, column: string) => {
    if (input[key] !== undefined) patch[column] = input[key];
  };
  set("status", "status");
  set("effectiveDailyQuota", "effective_daily_quota");
  set("effectiveQuotaReason", "effective_quota_reason");
  set("attemptedCount", "attempted_count");
  set("succeededCount", "succeeded_count");
  set("alreadyFollowingCount", "already_following_count");
  set("skippedCount", "skipped_count");
  set("failedCount", "failed_count");
  set("consecutiveFailures", "consecutive_failures");
  set("rateLimitedUntil", "rate_limited_until");
  set("rateLimitRemaining", "rate_limit_remaining");
  set("rateLimitResetAt", "rate_limit_reset_at");
  set("lastErrorCode", "last_error_code");
  set("lastErrorMessage", "last_error_message");
  set("completedAt", "completed_at");
  set("lastChunkAt", "last_chunk_at");

  const { error } = await client(input.db)
    .from("bluesky_follow_campaign_runs")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.runId);
  if (error) throw fromPostgres(error, "Could not update the run.");
}

export interface RunPage {
  rows: BlueskyFollowCampaignRunRow[];
  info: PageInfo;
}

export async function listRunsPage(input: {
  workspaceId: string;
  campaignId: string;
  page?: number;
  pageSize?: number;
  db?: Db;
}): Promise<RunPage> {
  const supabase = client(input.db);
  const pageSize = Math.min(
    Math.max(input.pageSize ?? CAMPAIGN_RUN_PAGE_SIZE, 1),
    100,
  );
  const page = Math.max(input.page ?? 1, 1);
  const from = (page - 1) * pageSize;

  const scope = (q: FilteredQuery): FilteredQuery =>
    q.eq("workspace_id", input.workspaceId).eq("campaign_id", input.campaignId);

  const { count, error: countError } = await scope(
    asFiltered(
      supabase
        .from("bluesky_follow_campaign_runs")
        .select("id", { count: "exact", head: true }),
    ),
  );
  if (countError) throw fromPostgres(countError, "Could not count runs.");

  const { data, error } = await scope(
    asFiltered(supabase.from("bluesky_follow_campaign_runs").select("*")),
  )
    .order("local_date", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) throw fromPostgres(error, "Could not list runs.");

  const total = count ?? 0;
  return {
    rows: (data ?? []) as unknown as BlueskyFollowCampaignRunRow[],
    info: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

// =====================================================================
// Per-identity daily usage
// =====================================================================

export async function getIdentityUsage(input: {
  workspaceId: string;
  operatorAccountId: string;
  usageDate: string;
  db?: Db;
}): Promise<BlueskyIdentityDailyUsageRow | null> {
  const { data, error } = await client(input.db)
    .from("bluesky_identity_daily_usage")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId)
    .eq("usage_date", input.usageDate)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read identity usage.");
  return (data as unknown as BlueskyIdentityDailyUsageRow) ?? null;
}

/**
 * Increment a day's usage atomically.
 *
 * An increment in SQL rather than a read-modify-write, so two campaigns
 * sharing an identity cannot lose each other's consumption.
 */
export async function recordIdentityUsage(input: {
  workspaceId: string;
  operatorAccountId: string;
  usageDate: string;
  followsCreated: number;
  attemptsMade: number;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db).rpc("record_bluesky_identity_usage", {
    p_workspace_id: input.workspaceId,
    p_operator_account_id: input.operatorAccountId,
    p_usage_date: input.usageDate,
    p_follows_created: input.followsCreated,
    p_attempts_made: input.attemptsMade,
  });
  if (error) throw fromPostgres(error, "Could not record identity usage.");
}

// =====================================================================
// Kill switches
// =====================================================================

export async function listKillSwitches(
  workspaceId: string,
  db?: Db,
): Promise<BlueskyCampaignKillSwitchRow[]> {
  const { data, error } = await client(db)
    .from("bluesky_campaign_kill_switches")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (error) throw fromPostgres(error, "Could not read kill switches.");
  return (data ?? []) as unknown as BlueskyCampaignKillSwitchRow[];
}

export async function setKillSwitch(input: {
  workspaceId: string;
  /** Null for the workspace-global switch. */
  operatorAccountId: string | null;
  engaged: boolean;
  reason: string | null;
  engagedBy: string | null;
  db?: Db;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client(input.db)
    .from("bluesky_campaign_kill_switches")
    .upsert(
      {
        workspace_id: input.workspaceId,
        operator_account_id: input.operatorAccountId,
        engaged: input.engaged,
        reason: input.reason,
        engaged_by: input.engagedBy,
        engaged_at: now,
        released_at: input.engaged ? null : now,
      } as never,
      {
        onConflict: input.operatorAccountId
          ? "workspace_id,operator_account_id"
          : "workspace_id",
      },
    );
  if (error) throw fromPostgres(error, "Could not set the kill switch.");
}

// =====================================================================
// Query-builder narrowing
// =====================================================================
//
// Same pattern the relationship repository uses and for the same
// reason: threading Supabase's generic builder through these helpers
// makes TypeScript recurse until it gives up, and this repo's ESLint
// config has no typescript-eslint plugin so a disable comment is itself
// a lint error. The builder is narrowed once at each entry point and
// the row shape is asserted on the way out.

interface FilteredQuery extends PromiseLike<QueryResponse> {
  eq(column: string, value: unknown): FilteredQuery;
  in(column: string, values: readonly unknown[]): FilteredQuery;
  or(filters: string): FilteredQuery;
  order(column: string, options?: { ascending?: boolean }): FilteredQuery;
  range(from: number, to: number): FilteredQuery;
}

interface QueryResponse {
  data: unknown;
  error: { message?: unknown; code?: unknown } | null;
  count?: number | null;
}

function asFiltered(builder: unknown): FilteredQuery {
  return builder as FilteredQuery;
}
