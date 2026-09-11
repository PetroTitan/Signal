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
 * Settle one reservation: apply outcome DELTAS and release its quota.
 *
 * Takes the reservation's ID rather than a count. A count was the
 * defect: it was subtracted from whatever `reserved_count` happened to
 * hold at that moment, so a worker that settled late could consume a
 * reservation another worker had just opened. Quoting the ID lets the
 * RPC verify ownership, apply the deltas exactly once, and treat a
 * duplicate settlement as a no-op.
 *
 * Never write absolute counters computed from a snapshot: the previous
 * code read the run at the start of a tick, added its chunk totals in
 * memory and wrote the result, which loses every concurrent increment.
 */
export async function applyRunOutcome(input: {
  workspaceId: string;
  runId: string;
  operatorAccountId: string;
  usageDate: string;
  attempted: number;
  succeeded: number;
  alreadyFollowing: number;
  skipped: number;
  failed: number;
  recordsCreated: number;
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
      p_run_id: input.runId,
      p_operator_account_id: input.operatorAccountId,
      p_usage_date: input.usageDate,
      p_reservation_id: input.reservationId,
      p_attempted: input.attempted,
      p_succeeded: input.succeeded,
      p_already_following: input.alreadyFollowing,
      p_skipped: input.skipped,
      p_failed: input.failed,
      p_records_created: input.recordsCreated,
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
    attemptedCount: Number(row.out_attempted ?? 0),
    succeededCount: Number(row.out_succeeded ?? 0),
    reservedCount: Number(row.out_reserved ?? 0),
  };
}

export interface SettlementResult {
  /** True only when THIS call applied the deltas. */
  settled: boolean;
  /** True when the reservation had already been settled. */
  alreadySettled: boolean;
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

/** The audit row's verdict on whether this worker may call the provider. */
export interface ActionClaim {
  actionId: string;
  mayMutate: boolean;
  needsReconcile: boolean;
  terminal: boolean;
  existingStatus: string | null;
}

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
}): Promise<ActionClaim> {
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
        action_id: string;
        may_mutate: boolean;
        needs_reconcile: boolean;
        terminal: boolean;
        existing_status: string | null;
      }
    | undefined;
  if (!row) throw fromPostgres(null, "Audit row could not be claimed.");
  return {
    actionId: row.action_id,
    mayMutate: row.may_mutate,
    needsReconcile: row.needs_reconcile,
    terminal: row.terminal,
    existingStatus: row.existing_status,
  };
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
