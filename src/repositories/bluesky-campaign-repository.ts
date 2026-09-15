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
  /**
   * follow | unfollow. Defaults to `follow`, so every existing call
   * site keeps exactly the behaviour it had.
   *
   * Immutable once written — a trigger refuses a change — because a
   * campaign that switched kind mid-queue would act on its members with
   * the opposite of the operator's intent.
   */
  kind?: "follow" | "unfollow";
  db?: Db;
}): Promise<BlueskyFollowCampaignRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaigns")
    .insert({
      workspace_id: input.workspaceId,
      operator_account_id: input.operatorAccountId,
      name: input.name,
      kind: input.kind ?? "follow",
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
/**
 * Campaigns that are due right now, OF ONE KIND.
 *
 * `kind` defaults to `"follow"` and is applied as a query filter rather
 * than left to the caller, because the failure it prevents is the worst
 * one available in this subsystem: the follow dispatcher picking up an
 * unfollow campaign and FOLLOWING a queue of people the operator asked
 * to unfollow.
 *
 * This filter is the first of three guards, not the only one. The
 * database refuses the same mistake independently —
 * `claim_bluesky_campaign_action` raises on a campaign whose kind is
 * not `follow`, and `claim_bluesky_unfollow_action` raises on one whose
 * kind is not `unfollow` — so a bug here cannot become a public act.
 */
/**
 * Record that the dispatcher is about to serve this campaign a chunk.
 *
 * Written BEFORE the chunk runs, so an invocation killed mid-chunk has
 * already moved the campaign to the back of the next round: fairness
 * does not depend on the invocation surviving. Workspace-scoped like
 * every other write here. Never fails the tick — a lost hint costs one
 * round of ordering, nothing else.
 */
export async function touchCampaignDispatched(input: {
  workspaceId: string;
  campaignId: string;
  nowIso?: string;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_follow_campaigns")
    .update({ last_dispatched_at: input.nowIso ?? new Date().toISOString() })
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.campaignId);
  if (error) throw fromPostgres(error, "Failed to record dispatch order.");
}

export async function listDueCampaigns(input: {
  nowIso: string;
  limit?: number;
  kind?: "follow" | "unfollow";
  /**
   * Which campaign statuses are eligible. Defaults to `active` only,
   * so the FOLLOW dispatcher's behaviour is byte-for-byte unchanged.
   *
   * The unfollow dispatcher additionally accepts `rate_limited`,
   * because it surfaces that as a campaign state an operator can see —
   * and a temporary, automatic condition must not remove a campaign
   * from the scheduler's view. A status the dispatcher cannot list is a
   * status the dispatcher cannot leave.
   */
  statuses?: string[];
  db?: Db;
}): Promise<BlueskyFollowCampaignRow[]> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaigns")
    .select("*")
    .eq("kind", input.kind ?? "follow")
    .in("status", input.statuses ?? ["active"])
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
  /** Retained for source compatibility; allocation is database-owned. */
  startSequence?: number;
  db?: Db;
}): Promise<ImportResult> {
  if (input.members.length === 0) {
    return { inserted: 0, duplicates: 0, lastSequence: 0 };
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

  const payload = [...unique.values()].map((m) => ({
    subject_did: m.subjectDid,
    current_handle: m.currentHandle,
    display_name: m.displayName,
    target_profile_id: m.targetProfileId ?? null,
    source_label: m.sourceLabel ?? "import",
  }));

  // The RPC locks the campaign, allocates the next range and inserts in
  // one transaction. Reading max(import_sequence) in JavaScript and
  // inserting later allowed two importers to allocate the same range.
  const { data, error } = await supabase.rpc(
    "import_bluesky_campaign_member_chunk",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_members: payload,
    },
  );
  if (error) throw fromPostgres(error, "Could not import campaign members.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_inserted?: number;
        out_duplicates?: number;
        out_last_sequence?: number;
      }
    | undefined;
  if (!row) throw fromPostgres(null, "Could not import campaign members.");

  return {
    inserted: Number(row.out_inserted ?? 0),
    duplicates: Number(row.out_duplicates ?? 0),
    lastSequence: Number(row.out_last_sequence ?? 0),
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
  /**
   * What is not finished.
   *
   * Includes `claimed` and `running`. A member leased by a worker that
   * then died is NOT terminal — its lease lapses and it returns to the
   * queue — and counting it as finished let a crash silently COMPLETE a
   * campaign with work outstanding. Including it costs at most one
   * extra tick before a genuinely finished campaign closes.
   */
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
    remainingEligible: queued + retryable + claimed + running,
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

/**
 * Atomically reserve quota AND claim exactly that many members.
 *
 * This replaces the read-compute-claim-later-increment sequence that
 * allowed two dispatchers to collectively exceed the daily quota. Both
 * read "0 used today", both computed the full quota, and both proceeded
 * — disjoint member claims bound who touches which row, not how many
 * attempts happen in total.
 *
 * The reservation is what bounds the total, and it is taken under row
 * locks inside the RPC so the read of remaining headroom and the write
 * claiming it cannot interleave.
 */
export async function reserveAndClaim(input: {
  workspaceId: string;
  campaignId: string;
  runId: string;
  operatorAccountId: string;
  usageDate: string;
  requested: number;
  identityCeiling: number;
  chunkSize: number;
  leaseSeconds: number;
  claimedBy: string;
  db?: Db;
}): Promise<QuotaReservation> {
  const { data, error } = await client(input.db).rpc(
    "reserve_bluesky_campaign_quota",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_run_id: input.runId,
      p_operator_account_id: input.operatorAccountId,
      p_usage_date: input.usageDate,
      p_requested: input.requested,
      p_identity_ceiling: input.identityCeiling,
      p_chunk_size: input.chunkSize,
      p_lease_seconds: input.leaseSeconds,
      p_claimed_by: input.claimedBy,
    },
  );
  if (error) throw fromPostgres(error, "Could not reserve campaign quota.");

  const rows = (data ?? []) as unknown as {
    reserved: number;
    reservation_id: string | null;
    reason: string | null;
    member_id: string | null;
    subject_did: string | null;
    current_handle: string | null;
    import_sequence: number | null;
    attempt_count: number | null;
    provider_record_rkey: string | null;
  }[];

  // A zero reservation returns one row with a null member and the
  // reason it granted nothing.
  const members = rows
    .filter((r) => r.member_id !== null)
    .map((r) => ({
      id: r.member_id as string,
      subject_did: r.subject_did as string,
      current_handle: r.current_handle,
      import_sequence: Number(r.import_sequence ?? 0),
      attempt_count: Number(r.attempt_count ?? 0),
      provider_record_rkey: r.provider_record_rkey,
    }));

  return {
    reserved: members.length,
    reservationId: rows[0]?.reservation_id ?? null,
    reason: (rows[0]?.reason ?? "queue_empty") as ReservationReason,
    members,
  };
}

/**
 * Why a reservation granted nothing.
 *
 * "Reserved zero" is several different situations and the caller must
 * act differently on each: a spent quota should close the day's run and
 * schedule tomorrow, an empty queue should complete the campaign, and a
 * paused run should do neither. Collapsing them into a bare zero is how
 * the dispatcher ended up spinning on a finished campaign every tick.
 */
export type ReservationReason =
  | "granted"
  /** Took over a held reservation to reconcile it. Consumes no quota. */
  | "reconcile"
  | "quota_exhausted"
  | "identity_exhausted"
  | "queue_empty"
  | "nothing_requested"
  | "run_not_running"
  | "run_missing";

export interface QuotaReservation {
  reserved: number;
  /**
   * The reservation that OWNS this quota until it is settled.
   *
   * Settlement quotes it back, which is what makes settlement
   * idempotent and stops a late worker consuming a reservation that
   * belongs to someone else.
   */
  reservationId: string | null;
  reason: ReservationReason;
  members: ClaimedMember[];
}

export interface ClaimedMember {
  id: string;
  subject_did: string;
  current_handle: string | null;
  import_sequence: number;
  attempt_count: number;
  provider_record_rkey: string | null;
}

/**
 * Settle one reservation.
 *
 * Deliberately takes NO chunk totals. It folds the attempt ledger —
 * the rows the worker wrote as it went — so a chunk that ended in a
 * crash and one that ended normally are recovered by the same path.
 * Passing in-memory deltas was the defect: a worker that dies has no
 * in-memory deltas, and its real attempts were simply lost.
 *
 * The whole tenant tuple is quoted so the RPC can verify it. Checking
 * only the run left a reservation from another workspace, campaign,
 * identity or usage date able to settle against this one — and every
 * one of those is a different budget.
 */
export async function applyRunOutcome(input: {
  workspaceId: string;
  campaignId: string;
  runId: string;
  operatorAccountId: string;
  usageDate: string;
  reservationId: string;
  consecutiveFailures: number;
  rateLimitedUntil?: string | null;
  rateLimitRemaining?: number | null;
  rateLimitResetAt?: string | null;
  db?: Db;
}): Promise<SettlementResult | null> {
  const { data, error } = await client(input.db).rpc(
    "apply_bluesky_run_outcome",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_run_id: input.runId,
      p_operator_account_id: input.operatorAccountId,
      p_usage_date: input.usageDate,
      p_reservation_id: input.reservationId,
      p_consecutive_failures: input.consecutiveFailures,
      p_rate_limited_until: input.rateLimitedUntil ?? null,
      p_rate_limit_remaining: input.rateLimitRemaining ?? null,
      p_rate_limit_reset_at: input.rateLimitResetAt ?? null,
    },
  );
  if (error) throw fromPostgres(error, "Could not record the run outcome.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        settled: boolean;
        already_settled: boolean;
        refused_reason: string | null;
        out_run_id: string | null;
        out_attempted: number | null;
        out_succeeded: number | null;
        out_reserved: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    settled: row.settled === true,
    alreadySettled: row.already_settled === true,
    refusedReason: row.refused_reason,
    attemptedCount: Number(row.out_attempted ?? 0),
    succeededCount: Number(row.out_succeeded ?? 0),
    reservedCount: Number(row.out_reserved ?? 0),
  };
}

/**
 * Convert one reserved unit into a durable attempted unit.
 *
 * Called immediately BEFORE the provider mutation and nowhere else.
 * After it returns, the quota is spent as far as every other worker is
 * concerned — which is the property that survives this process being
 * killed a millisecond later.
 *
 * It also raises the audit row's in-flight marker, in the SAME
 * transaction. The marker used to go up when the audit row was created,
 * which described a request that had not been made: a worker that died
 * before this point left the member permanently in reconciliation-only
 * mode, and it was never followed at all.
 *
 * So the two halves of "an attempt was made" now commit together. A
 * failure before this returns leaves the member safe to retry from
 * scratch; a failure after it leaves the member reconciliation-only.
 * There is no state in between.
 *
 * Idempotent per (reservation, member). A `false` result with a reason
 * means the mutation MUST NOT be sent.
 */
export async function consumeMemberQuota(input: {
  workspaceId: string;
  campaignId: string;
  runId: string;
  reservationId: string;
  memberId: string;
  /** The exact action this attempt is for. Required, and verified. */
  actionId: string;
  operatorAccountId: string;
  db?: Db;
}): Promise<{
  mayMutate: boolean;
  alreadyConsumed: boolean;
  refusedReason: string | null;
}> {
  const { data, error } = await client(input.db).rpc(
    "consume_bluesky_member_quota",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_run_id: input.runId,
      p_reservation_id: input.reservationId,
      p_member_id: input.memberId,
      p_action_id: input.actionId,
      p_operator_account_id: input.operatorAccountId,
    },
  );
  if (error) throw fromPostgres(error, "Could not reserve the attempt.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        consumed: boolean;
        already_consumed: boolean;
        refused_reason: string | null;
      }
    | undefined;
  if (!row) {
    return { mayMutate: false, alreadyConsumed: false, refusedReason: "no_result" };
  }
  return {
    // An already-consumed unit still permits the mutation: this is the
    // retry of a call whose response was lost, and the unit is paid for.
    mayMutate: row.consumed === true || row.already_consumed === true,
    alreadyConsumed: row.already_consumed === true,
    refusedReason: row.refused_reason,
  };
}

export interface SettlementResult {
  /** True only when THIS call folded the ledger. */
  settled: boolean;
  /** True when the reservation had already been settled. */
  alreadySettled: boolean;
  /** Which part of the tenant tuple disagreed, when it refused. */
  refusedReason: string | null;
  attemptedCount: number;
  succeededCount: number;
  reservedCount: number;
}

/**
 * Serialise dispatching per campaign-day.
 *
 * The reservation system bounds how much quota concurrent workers can
 * spend, but "consecutive failures" is a property of a SEQUENCE, and
 * two interleaved workers do not have one: both read 3, both write 4,
 * and a breaker set to trip at 5 never trips. A lease rather than a
 * lock because the holder is a serverless function that can vanish
 * without releasing anything.
 */
/**
 * How many of this campaign's actions are still unresolved.
 *
 * An action that is neither succeeded, failed nor skipped describes a
 * public mutation whose outcome we do not know. Reconciling it costs no
 * quota, so a day whose allowance is spent should still come back for
 * it rather than leaving the ambiguity standing until tomorrow.
 */
export async function countUnresolvedCampaignActions(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<number> {
  const { count, error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .in("status", ["pending", "running", "reconciliation_required"]);
  if (error) {
    throw fromPostgres(error, "Could not count unresolved campaign actions.");
  }
  return count ?? 0;
}

export async function acquireDispatchLease(input: {
  workspaceId: string;
  runId: string;
  owner: string;
  leaseSeconds: number;
  db?: Db;
}): Promise<boolean> {
  const { data, error } = await client(input.db).rpc(
    "acquire_bluesky_run_dispatch_lease",
    {
      p_workspace_id: input.workspaceId,
      p_run_id: input.runId,
      p_owner: input.owner,
      p_lease_seconds: input.leaseSeconds,
    },
  );
  if (error) throw fromPostgres(error, "Could not acquire the dispatch lease.");
  return data === true;
}

export async function releaseDispatchLease(input: {
  workspaceId: string;
  runId: string;
  owner: string;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db).rpc(
    "release_bluesky_run_dispatch_lease",
    {
      p_workspace_id: input.workspaceId,
      p_run_id: input.runId,
      p_owner: input.owner,
    },
  );
  if (error) throw fromPostgres(error, "Could not release the dispatch lease.");
}

/**
 * Permission to call the provider for one member.
 *
 * Only `claimCampaignAction` constructs one, and only on the verdict
 * that actually grants it. It is a type, not a boolean, because the
 * boolean version was simply never read: the worker branched on
 * `terminal` and `needsReconcile`, and the "this member is not yours"
 * verdict fell through to the mutation path. A worker that had lost the
 * race sent a second follow for a member another worker owned.
 *
 * Making the mutation function TAKE one of these means reaching it
 * without permission is a compile error rather than a duplicate follow.
 */
declare const permitBrand: unique symbol;
export interface MutationPermit {
  readonly actionId: string;
  readonly [permitBrand]: true;
}

/**
 * The audit row's verdict, as a closed set.
 *
 * Four outcomes, and the caller must handle all four. The RPC reports
 * them as three independent booleans, which is how a combination that
 * meant "not yours" ended up looking like "nothing special".
 */
export type ActionClaimVerdict =
  /** This worker owns the attempt and may call the provider. */
  | { kind: "may_mutate"; actionId: string; permit: MutationPermit }
  /** A request may already have been sent. Read truth, never re-send. */
  | { kind: "reconcile_only"; actionId: string }
  /** The audit row has already reached a final state. */
  | {
      kind: "terminal";
      actionId: string;
      status: "succeeded" | "failed" | "reconciliation_required";
    }
  /**
   * The row belongs to another worker, or the verdict made no sense.
   *
   * NOT reconciliation: no provider intent exists for this worker and
   * nothing has been sent on its behalf. The only correct response is
   * to leave the member entirely alone.
   */
  | { kind: "denied"; actionId: string | null; existingStatus: string | null };

/**
 * Create or take over the audit row for one member.
 *
 * The worker previously never wrote one, which meant the unique index
 * on (campaign_id, campaign_member_id) guarded an empty set and History
 * showed nothing for campaign work. Creating the row BEFORE the
 * provider call is what makes a crash recoverable: a row still marked
 * in-flight after a lease lapses means the request MAY have succeeded,
 * and the answer is to reconcile, never to send again.
 */
export async function claimCampaignAction(input: {
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
  db?: Db;
}): Promise<ActionClaimVerdict> {
  const { data, error } = await client(input.db).rpc(
    "claim_bluesky_campaign_action",
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
    },
  );
  if (error) throw fromPostgres(error, "Could not claim the audit row.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        action_id: string | null;
        may_mutate: boolean;
        needs_reconcile: boolean;
        terminal: boolean;
        existing_status: string | null;
      }
    | undefined;
  if (!row) throw fromPostgres(null, "Audit row could not be claimed.");
  return toClaimVerdict(row);
}

/**
 * Collapse the RPC's three booleans into the closed set, fail-closed.
 *
 * Order matters. A terminal row is terminal whatever else is set; a row
 * that may have a request in flight is reconciliation-only; permission
 * is granted only when the RPC says so explicitly. Anything left over —
 * including the lost-race verdict, where all three are false — is
 * DENIED, because the one thing worse than refusing work we could have
 * done is doing work that belongs to someone else.
 */
export function toClaimVerdict(row: {
  action_id: string | null;
  may_mutate: boolean;
  needs_reconcile: boolean;
  terminal: boolean;
  existing_status: string | null;
}): ActionClaimVerdict {
  const actionId = row.action_id;

  if (row.terminal) {
    if (
      actionId &&
      (row.existing_status === "succeeded" ||
        row.existing_status === "failed" ||
        row.existing_status === "reconciliation_required")
    ) {
      return { kind: "terminal", actionId, status: row.existing_status };
    }
    // Terminal with a status we do not recognise. Refuse rather than
    // guess what a future status means for a public action.
    return { kind: "denied", actionId, existingStatus: row.existing_status };
  }

  if (actionId && row.needs_reconcile) {
    return { kind: "reconcile_only", actionId };
  }

  if (actionId && row.may_mutate) {
    return {
      kind: "may_mutate",
      actionId,
      permit: { actionId } as MutationPermit,
    };
  }

  return { kind: "denied", actionId, existingStatus: row.existing_status };
}

/** Finalise the audit row. Always clears the in-flight marker. */
export async function completeCampaignAction(input: {
  workspaceId: string;
  actionId: string;
  status: "succeeded" | "failed" | "reconciliation_required" | "skipped";
  followUri?: string | null;
  followRkey?: string | null;
  followCid?: string | null;
  providerStatusCode?: number | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  reconciledState?: string | null;
  reconciliationNote?: string | null;
  db?: Db;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    // Cleared on every terminal path: a lingering marker would send the
    // next worker into reconciliation for an action that is finished.
    provider_in_flight_at: null,
    finished_at: new Date().toISOString(),
  };
  const set = <K extends keyof typeof input>(key: K, column: string) => {
    if (input[key] !== undefined) patch[column] = input[key];
  };
  set("followUri", "follow_uri");
  set("followRkey", "follow_rkey");
  set("followCid", "follow_cid");
  set("providerStatusCode", "provider_status_code");
  set("providerErrorCode", "provider_error_code");
  set("providerErrorMessage", "provider_error_message");
  set("reconciledState", "reconciled_state");
  set("reconciliationNote", "reconciliation_note");
  if (input.reconciliationNote !== undefined) {
    patch.reconciled_at = new Date().toISOString();
  }

  const { error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.actionId);
  if (error) throw fromPostgres(error, "Could not finalise the audit row.");
}

/**
 * Return a rate-limited run to running once the provider reset passed.
 *
 * Same run, same local day, same remaining quota — a second run for the
 * day would double the day's budget. Guarded inside the RPC so an
 * operator pause is never undone by the scheduler.
 */
export async function resumeRateLimitedRun(input: {
  workspaceId: string;
  runId: string;
  db?: Db;
}): Promise<BlueskyFollowCampaignRunRow | null> {
  const { data, error } = await client(input.db).rpc(
    "resume_bluesky_campaign_run",
    { p_workspace_id: input.workspaceId, p_run_id: input.runId },
  );
  if (error) throw fromPostgres(error, "Could not resume the run.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | BlueskyFollowCampaignRunRow
    | undefined;
  return row ?? null;
}

/** Return untouched leased rows to the queue without spending an attempt. */
/**
 * Return leased members to the queue — ONLY those still held by this
 * worker under this reservation.
 *
 * The unqualified version releases by id alone, so a worker whose lease
 * had lapsed could clear the lease of whoever reclaimed the row, while
 * a request for it was potentially in flight.
 */
export async function releaseOwnedMembers(input: {
  workspaceId: string;
  campaignId: string;
  memberIds: string[];
  claimedBy: string;
  reservationId: string;
  db?: Db;
}): Promise<number> {
  if (input.memberIds.length === 0) return 0;
  const { data, error } = await client(input.db).rpc(
    "release_bluesky_campaign_members_owned",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_member_ids: input.memberIds,
      p_claimed_by: input.claimedBy,
      p_reservation_id: input.reservationId,
    },
  );
  if (error) throw fromPostgres(error, "Could not release campaign members.");
  return Number(data ?? 0);
}

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

/**
 * The run for one local date, by the unique key.
 *
 * A single-row lookup rather than a page of runs, because the summary
 * panel on the Relationships page wants exactly this row and nothing
 * else. `(campaign_id, local_date)` is unique, so there is never a
 * second.
 */
export async function getRunForLocalDate(input: {
  workspaceId: string;
  campaignId: string;
  localDate: string;
  db?: Db;
}): Promise<BlueskyFollowCampaignRunRow | null> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaign_runs")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .eq("local_date", input.localDate)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read today's run.");
  return (data as unknown as BlueskyFollowCampaignRunRow) ?? null;
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

/**
 * Runs, newest first, by KEYSET on `local_date` (unique per campaign).
 * `nextCursor` is the local date to pass back as `beforeLocalDate` for
 * the next page; null when there is no more.
 */
export interface RunKeysetPage {
  rows: BlueskyFollowCampaignRunRow[];
  nextCursor: string | null;
}

export async function listRunsKeyset(input: {
  workspaceId: string;
  campaignId: string;
  beforeLocalDate?: string | null;
  pageSize?: number;
  db?: Db;
}): Promise<RunKeysetPage> {
  const pageSize = Math.min(Math.max(input.pageSize ?? CAMPAIGN_RUN_PAGE_SIZE, 1), 100);
  let query = client(input.db)
    .from("bluesky_follow_campaign_runs")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId);
  if (input.beforeLocalDate) query = query.lt("local_date", input.beforeLocalDate);
  const { data, error } = await query
    .order("local_date", { ascending: false })
    .limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list runs.");
  const rows = ((data ?? []) as unknown as BlueskyFollowCampaignRunRow[]);
  const page = rows.slice(0, pageSize);
  return {
    rows: page,
    nextCursor:
      rows.length > pageSize
        ? (() => {
            const v: unknown = page[page.length - 1].local_date;
            return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
          })()
        : null,
  };
}

/**
 * Members by KEYSET on `import_sequence`, which is unique per campaign
 * and never changes — so a page taken while the dispatcher is moving
 * rows between states never skips or repeats a member, which OFFSET
 * paging over a mutable queue does. `nextCursor` is the sequence to
 * pass back as `afterSequence`.
 */
export interface MemberKeysetPage {
  rows: BlueskyFollowCampaignMemberRow[];
  nextCursor: number | null;
}

export async function listMembersKeyset(input: {
  workspaceId: string;
  campaignId: string;
  afterSequence?: number | null;
  statuses?: BlueskyCampaignMemberStatus[];
  pageSize?: number;
  db?: Db;
}): Promise<MemberKeysetPage> {
  const pageSize = Math.min(Math.max(input.pageSize ?? CAMPAIGN_MEMBER_PAGE_SIZE, 1), 100);
  let query = client(input.db)
    .from("bluesky_follow_campaign_members")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId);
  if (input.statuses && input.statuses.length > 0) query = query.in("status", input.statuses);
  if (input.afterSequence !== undefined && input.afterSequence !== null) {
    query = query.gt("import_sequence", input.afterSequence);
  }
  const { data, error } = await query
    .order("import_sequence", { ascending: true })
    .limit(pageSize + 1);
  if (error) throw fromPostgres(error, "Could not list members.");
  const rows = ((data ?? []) as unknown as BlueskyFollowCampaignMemberRow[]);
  const page = rows.slice(0, pageSize);
  return {
    rows: page,
    nextCursor: rows.length > pageSize ? Number(page[page.length - 1].import_sequence) : null,
  };
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
        // Single conflict target for both rows. The table previously
        // carried two PARTIAL unique indexes (one where
        // operator_account_id is null, one where it is not), and
        // ON CONFLICT cannot infer a partial index — so the global
        // switch's upsert never matched and a second engage raised a
        // duplicate instead of updating. The hotfix replaced them with
        // one total unique index over the generated `identity_key`
        // column, which both rows share.
        onConflict: "workspace_id,identity_key",
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

// =====================================================================
// Run recovery, re-opening, and conservation (20260915000001)
// =====================================================================

/**
 * Return a rejected-before-write action to `pending` for a real retry.
 *
 * Refused by the database for any error code that does not PROVE the
 * provider wrote nothing — a network error or a 5xx is ambiguous and
 * must stay in reconciliation. The unit the refused request spent stays
 * spent; the ledger row keeps its intent. Only the action's status and
 * in-flight marker move, which is what lets the ordinary claim path see
 * "owed a first attempt" and the reconciliation takeover see nothing.
 */
export async function reopenCampaignAction(input: {
  workspaceId: string;
  actionId: string;
  memberId: string;
  errorCode: string;
  errorMessage: string | null;
  db?: Db;
}): Promise<{ reopened: boolean; refusedReason: string | null }> {
  const { data, error } = await client(input.db).rpc(
    "reopen_bluesky_campaign_action",
    {
      p_workspace_id: input.workspaceId,
      p_action_id: input.actionId,
      p_member_id: input.memberId,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
    },
  );
  if (error) throw fromPostgres(error, "Could not re-open the audit row.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { reopened: boolean; refused_reason: string | null }
    | undefined;
  return {
    reopened: row?.reopened === true,
    refusedReason: row?.refused_reason ?? null,
  };
}

/**
 * The provider error an action last recorded.
 *
 * Read by the reconciliation path to decide whether an action filed as
 * `reconciliation_required` BEFORE the rejected-vs-ambiguous distinction
 * existed can be re-opened: a stored ExpiredToken proves the request was
 * refused before writing, however it was filed at the time.
 */
export async function getCampaignActionRejection(input: {
  workspaceId: string;
  actionId: string;
  db?: Db;
}): Promise<{ errorCode: string | null; statusCode: number | null } | null> {
  const { data, error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .select("provider_error_code, provider_status_code")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.actionId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the audit row.");
  if (!data) return null;
  const row = data as unknown as {
    provider_error_code: string | null;
    provider_status_code: number | null;
  };
  return { errorCode: row.provider_error_code, statusCode: row.provider_status_code };
}

/**
 * Stop every ACTIVE campaign of an identity for authentication — the
 * identity-wide transition, recorded with the identity's current token
 * generation so recovery can tell a completed session transition from
 * a merely `connected` status. Running runs become `waiting_for_auth`.
 * Never touches a paused, rate-limited, completed or cancelled campaign.
 */
export async function stopCampaignsForIdentity(input: {
  workspaceId: string;
  accountId: string;
  message: string;
  db?: Db;
}): Promise<{ campaignsStopped: number; runsStopped: number }> {
  const { data, error } = await client(input.db).rpc(
    "stop_bluesky_campaigns_for_identity",
    {
      p_workspace_id: input.workspaceId,
      p_account_id: input.accountId,
      p_message: input.message,
    },
  );
  if (error) throw fromPostgres(error, "Could not stop the identity's campaigns.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { campaigns_stopped: number | string | null; runs_stopped: number | string | null }
    | undefined;
  return {
    campaignsStopped: Number(row?.campaigns_stopped ?? 0),
    runsStopped: Number(row?.runs_stopped ?? 0),
  };
}

/**
 * Campaigns stopped for authentication whose identity is CONNECTED again
 * return to `active`, and today's run to `running` — in the database,
 * in one statement, with no provider probe. The proof that the session
 * works is the refresh (or reconnect) that set the connection to
 * `connected`; the next chunk's first request re-proves it.
 *
 * Optionally scoped to a workspace, an identity or a single campaign
 * (the manual "run now" recovers that campaign only). Never touches a
 * campaign an operator paused.
 */
export async function recoverReauthorizedCampaignsForConnectedIdentities(input: {
  workspaceId?: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  nowIso?: string;
  db?: Db;
}): Promise<{ campaignId: string; kind: "follow" | "unfollow"; runId: string | null; runResumed: boolean }[]> {
  const { data, error } = await client(input.db).rpc(
    "recover_bluesky_reauthorized_campaigns",
    {
      p_workspace_id: input.workspaceId ?? null,
      p_account_id: input.accountId ?? null,
      p_campaign_id: input.campaignId ?? null,
      p_now: input.nowIso ?? new Date().toISOString(),
    },
  );
  if (error) throw fromPostgres(error, "Could not recover campaigns for the identity.");
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as {
    campaign_id: string;
    kind: string;
    run_id: string | null;
    run_resumed: boolean;
  }[];
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    kind: r.kind === "unfollow" ? "unfollow" : "follow",
    runId: r.run_id ?? null,
    runResumed: r.run_resumed === true,
  }));
}

/**
 * Return today's run to `running` after a RECOVERABLE stop.
 *
 * Guarded in the database: only `paused`, `failed` or an elapsed
 * `rate_limited` run moves, and never one for a campaign an operator
 * paused — that state is on the campaign, which is not listed while
 * paused. Same run, same counters, same local day: a second run for
 * the day would double the day's budget.
 */
export async function resumeRunAfterRecovery(input: {
  workspaceId: string;
  campaignId: string;
  localDate: string;
  db?: Db;
}): Promise<{ resumed: boolean; runId: string | null; runStatus: string | null }> {
  const { data, error } = await client(input.db).rpc(
    "resume_bluesky_campaign_run_after_recovery",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_local_date: input.localDate,
    },
  );
  if (error) throw fromPostgres(error, "Could not resume today's run.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { resumed: boolean; run_id: string | null; run_status: string | null }
    | undefined;
  return {
    resumed: row?.resumed === true,
    runId: row?.run_id ?? null,
    runStatus: row?.run_status ?? null,
  };
}

export interface CampaignConservation {
  queuedTotal: number;
  pending: number;
  running: number;
  retryable: number;
  reconciliationRequired: number;
  succeeded: number;
  alreadyFollowing: number;
  protected: number;
  actorNotFound: number;
  blocked: number;
  invalid: number;
  failedStructural: number;
  cancelled: number;
  actionableRemaining: number;
  openLeases: number;
  openReservations: number;
  outstandingIntents: number;
  unresolvedActions: number;
  categorisedTotal: number;
}

/**
 * The conservation equation, computed by the database.
 *
 * Every member appears in exactly one category, and
 * `categorisedTotal === queuedTotal` is the assertion. The categories
 * are the operator-facing ones — "impossible with reason" is split by
 * the closed reason code a `skipped` member must carry.
 */
export async function getCampaignConservation(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<CampaignConservation> {
  const { data, error } = await client(input.db).rpc(
    "bluesky_campaign_conservation",
    { p_workspace_id: input.workspaceId, p_campaign_id: input.campaignId },
  );
  if (error) throw fromPostgres(error, "Could not compute campaign totals.");
  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, number | string | null>
    | undefined;
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    queuedTotal: n("queued_total"),
    pending: n("pending"),
    running: n("running"),
    retryable: n("retryable"),
    reconciliationRequired: n("reconciliation_required"),
    succeeded: n("succeeded"),
    alreadyFollowing: n("already_following"),
    protected: n("protected"),
    actorNotFound: n("actor_not_found"),
    blocked: n("blocked"),
    invalid: n("invalid"),
    failedStructural: n("failed_structural"),
    cancelled: n("cancelled"),
    actionableRemaining: n("actionable_remaining"),
    openLeases: n("open_leases"),
    openReservations: n("open_reservations"),
    outstandingIntents: n("outstanding_intents"),
    unresolvedActions: n("unresolved_actions"),
    categorisedTotal: n("categorised_total"),
  };
}

/**
 * May this campaign be marked completed?
 *
 * Asked of the database rather than derived from a status count in
 * process: completion requires nothing actionable AND no outstanding
 * lease, reservation, provider intent or unresolved action, and only
 * the database can see all five at once.
 */
export async function campaignMayComplete(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<boolean> {
  const { data, error } = await client(input.db).rpc(
    "bluesky_campaign_may_complete",
    { p_workspace_id: input.workspaceId, p_campaign_id: input.campaignId },
  );
  if (error) throw fromPostgres(error, "Could not check campaign completion.");
  return data === true;
}

/** Record one reconciliation read against a member. */
export async function bumpReconcileCount(input: {
  workspaceId: string;
  memberId: string;
  db?: Db;
}): Promise<number> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .select("reconcile_count")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.memberId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the member.");
  const current = Number((data as { reconcile_count?: number } | null)?.reconcile_count ?? 0);
  const next = current + 1;
  const { error: updateError } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .update({ reconcile_count: next } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.memberId);
  if (updateError) throw fromPostgres(updateError, "Could not record the reconciliation.");
  return next;
}

/**
 * Push a waiting member's next attempt out by a DURATION.
 *
 * The instant is computed by PostgreSQL, because `next_attempt_at` is
 * one side of a comparison PostgreSQL performs against its own `now()`.
 * Writing it from the application's clock makes eligibility depend on
 * two clocks agreeing — and when they do not, a backoff lands in the
 * past and stops being a backoff at all.
 */
export async function deferMember(input: {
  workspaceId: string;
  memberId: string;
  delaySeconds: number;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db).rpc("defer_bluesky_campaign_member", {
    p_workspace_id: input.workspaceId,
    p_member_id: input.memberId,
    p_delay_seconds: Math.max(1, Math.round(input.delaySeconds)),
  });
  if (error) throw fromPostgres(error, "Could not schedule the next attempt.");
}

/**
 * Terminal skips by their CLOSED reason code.
 *
 * Through the caller's own client, so RLS applies — this feeds the
 * campaign page, which must never reach for the service role. The
 * worker writes one of `TERMINAL_SKIP_REASONS` on every skipped or
 * protected member, which is what makes "impossible, with reason" a
 * breakdown rather than a lump.
 */
export async function countSkipReasons(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<Record<string, number>> {
  const { data, error } = await client(input.db)
    .from("bluesky_follow_campaign_members")
    .select("last_error_code")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .in("status", ["skipped", "protected"])
    .limit(10_000);
  if (error) throw fromPostgres(error, "Could not count skip reasons.");
  const out: Record<string, number> = {};
  for (const row of (data ?? []) as unknown as { last_error_code: string | null }[]) {
    const key = row.last_error_code ?? "unspecified";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Members whose action is in reconciliation — read-only until truth answers. */
export async function countReconcilingActions(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<number> {
  const { count, error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .eq("status", "reconciliation_required");
  if (error) throw fromPostgres(error, "Could not count reconciling actions.");
  return count ?? 0;
}
