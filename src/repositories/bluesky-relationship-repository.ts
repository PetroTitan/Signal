import "server-only";
/**
 * Persistence for Bluesky relationship actions.
 *
 * Every function takes an explicit `workspaceId` and every query filters
 * on it, even though RLS also enforces workspace membership. Two
 * reasons: some callers legitimately pass a service-role client (which
 * bypasses RLS entirely), and a filter in the query is checkable by a
 * test whereas a policy in the database is not, from here.
 *
 * `operatorAccountId` scopes everything further. "Do I follow this DID?"
 * is only meaningful relative to one operator account, so a candidate
 * corpus belongs to an identity, not to a workspace.
 *
 * What this module deliberately does NOT do:
 *   - it never deletes an action or a batch;
 *   - it never writes `relationship_state = 'not_following'` from
 *     anything other than a positive observation (the caller supplies
 *     the state; `unknown` is what a failure produces upstream);
 *   - it never constructs a follow rkey.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  BlueskyActionBatchRow,
  BlueskyActionStatus,
  BlueskyActionType,
  BlueskyCandidateRow,
  BlueskyCandidateSourceRow,
  BlueskyFollowRecordSource,
  BlueskyImportRunRow,
  BlueskyImportRunStatus,
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
  BlueskyTargetProfileRow,
} from "@/lib/supabase/types";
import { fromPostgres, notFound, RepositoryError } from "./errors";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

/**
 * Thrown when the database's one-active-action index refuses a second
 * concurrent mutation for the same (identity, subject, type).
 *
 * A distinct class because the caller's response is specific: this is
 * not an error to report, it is a duplicate to skip.
 */
export class DuplicateActiveActionError extends RepositoryError {
  constructor(subjectDid: string, actionType: BlueskyActionType) {
    super(
      `A ${actionType} for ${subjectDid} is already in progress.`,
      "constraint",
    );
    this.name = "DuplicateActiveActionError";
  }
}

/** Thrown when a write would change a confirmed batch's membership. */
export class BatchMembershipFrozenError extends RepositoryError {
  constructor(batchId: string) {
    super(
      `Batch ${batchId} is confirmed; its membership cannot change.`,
      "constraint",
    );
    this.name = "BatchMembershipFrozenError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === "23505"
  );
}

function mentionsFrozenBatch(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return false;
  }
  const message = String((error as { message: unknown }).message);
  return (
    message.includes("is confirmed; its membership is immutable") ||
    message.includes("cannot be moved between batches")
  );
}

// =====================================================================
// Target profiles
// =====================================================================

export interface UpsertTargetProfileInput {
  workspaceId: string;
  operatorAccountId: string;
  /** Canonical DID from the provider. Never operator-typed. */
  subjectDid: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  followersCount: number | null;
  /** What the operator actually typed, kept verbatim for the audit. */
  requestedIdentifier: string;
  createdBy: string | null;
  db?: Db;
}

/**
 * Create or refresh a target profile.
 *
 * Conflict is on (workspace, identity, subject_did) — the DID — so
 * re-adding a profile under a NEW handle updates the existing row and
 * keeps its import history, rather than forking a second target that
 * would re-import the same audience.
 */
export async function upsertTargetProfile(
  input: UpsertTargetProfileInput,
): Promise<BlueskyTargetProfileRow> {
  const supabase = client(input.db);
  const { data, error } = await supabase
    .from("bluesky_target_profiles")
    .upsert(
      {
        workspace_id: input.workspaceId,
        operator_account_id: input.operatorAccountId,
        subject_did: input.subjectDid,
        handle: input.handle,
        display_name: input.displayName,
        avatar_url: input.avatarUrl,
        followers_count: input.followersCount,
        requested_identifier: input.requestedIdentifier,
        profile_fetched_at: new Date().toISOString(),
        created_by: input.createdBy,
      } as never,
      { onConflict: "workspace_id,operator_account_id,subject_did" },
    )
    .select("*")
    .single();
  if (error) throw fromPostgres(error, "Could not save the target profile.");
  return data as unknown as BlueskyTargetProfileRow;
}

export async function listTargetProfiles(
  workspaceId: string,
  operatorAccountId: string,
  db?: Db,
): Promise<BlueskyTargetProfileRow[]> {
  const { data, error } = await client(db)
    .from("bluesky_target_profiles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("operator_account_id", operatorAccountId)
    .order("created_at", { ascending: false });
  if (error) throw fromPostgres(error, "Could not list target profiles.");
  return (data ?? []) as unknown as BlueskyTargetProfileRow[];
}

export async function getTargetProfile(
  workspaceId: string,
  targetProfileId: string,
  db?: Db,
): Promise<BlueskyTargetProfileRow | null> {
  const { data, error } = await client(db)
    .from("bluesky_target_profiles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", targetProfileId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the target profile.");
  return (data as unknown as BlueskyTargetProfileRow) ?? null;
}

export async function deleteTargetProfile(
  workspaceId: string,
  targetProfileId: string,
  db?: Db,
): Promise<void> {
  const { error } = await client(db)
    .from("bluesky_target_profiles")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", targetProfileId);
  if (error) throw fromPostgres(error, "Could not remove the target profile.");
}

// =====================================================================
// Import runs
// =====================================================================

export async function createImportRun(input: {
  workspaceId: string;
  targetProfileId: string;
  startedBy: string | null;
  db?: Db;
}): Promise<BlueskyImportRunRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_import_runs")
    .insert({
      workspace_id: input.workspaceId,
      target_profile_id: input.targetProfileId,
      status: "pending",
      started_by: input.startedBy,
    } as never)
    .select("*")
    .single();
  if (error) throw fromPostgres(error, "Could not start the import.");
  return data as unknown as BlueskyImportRunRow;
}

/**
 * The most recent run for a target, whatever its state.
 *
 * "Continue" resumes this run when it is resumable rather than starting
 * a fresh one, which is what keeps the provider cursor meaningful.
 */
export async function getLatestImportRun(
  workspaceId: string,
  targetProfileId: string,
  db?: Db,
): Promise<BlueskyImportRunRow | null> {
  const { data, error } = await client(db)
    .from("bluesky_import_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("target_profile_id", targetProfileId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the import run.");
  return (data as unknown as BlueskyImportRunRow) ?? null;
}

export interface UpdateImportRunInput {
  workspaceId: string;
  runId: string;
  status: BlueskyImportRunStatus;
  cursor: string | null;
  cursorExhausted: boolean;
  pagesFetched: number;
  followersSeen: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  stopReason: string | null;
  lastError: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  db?: Db;
}

/**
 * Persist a run's progress.
 *
 * The database's CHECK constraint refuses status='completed' unless
 * cursor_exhausted is true, so a caller that gets its completion logic
 * wrong gets a constraint violation rather than a false claim of a
 * complete import. The error is re-raised with that explanation rather
 * than a generic message.
 */
export async function updateImportRun(
  input: UpdateImportRunInput,
): Promise<BlueskyImportRunRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_import_runs")
    .update({
      status: input.status,
      cursor: input.cursor,
      cursor_exhausted: input.cursorExhausted,
      pages_fetched: input.pagesFetched,
      followers_seen: input.followersSeen,
      candidates_created: input.candidatesCreated,
      candidates_updated: input.candidatesUpdated,
      stop_reason: input.stopReason,
      last_error: input.lastError,
      ...(input.startedAt !== undefined ? { started_at: input.startedAt } : {}),
      ...(input.finishedAt !== undefined ? { finished_at: input.finishedAt } : {}),
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.runId)
    .select("*")
    .single();
  if (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      String((error as { message: unknown }).message).includes(
        "completion_requires_exhaustion",
      )
    ) {
      throw new RepositoryError(
        "Refused to mark this import complete: Bluesky has not stopped returning a cursor, so more followers remain.",
        "constraint",
        error,
      );
    }
    throw fromPostgres(error, "Could not save import progress.");
  }
  return data as unknown as BlueskyImportRunRow;
}

// =====================================================================
// Candidates
// =====================================================================

export interface DiscoveredFollower {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface RecordDiscoveriesResult {
  created: number;
  updated: number;
  /** Candidate id by DID, for the source attribution write. */
  idsByDid: Map<string, string>;
}

/**
 * Record a page of discovered followers as candidates.
 *
 * Idempotent by construction: the upsert conflicts on
 * (workspace, identity, subject_did), so re-importing an audience
 * updates metadata and `last_discovered_at` without creating a second
 * row and without disturbing `first_discovered_at`, the relationship
 * state, the follow-record identity, the protected flag, or any action
 * history.
 *
 * A CHANGED HANDLE flows through here: the DID matches, so the handle
 * column is overwritten and everything keyed off the row survives. That
 * is the whole reason identity is the DID.
 */
export async function recordDiscoveredCandidates(input: {
  workspaceId: string;
  operatorAccountId: string;
  followers: DiscoveredFollower[];
  db?: Db;
}): Promise<RecordDiscoveriesResult> {
  const idsByDid = new Map<string, string>();
  if (input.followers.length === 0) {
    return { created: 0, updated: 0, idsByDid };
  }
  const supabase = client(input.db);

  // Which of these DIDs do we already know? Needed to report
  // created-vs-updated honestly; an upsert alone cannot tell us.
  const dids = input.followers.map((f) => f.did);
  const { data: existingRows, error: existingError } = await supabase
    .from("bluesky_candidates")
    .select("id, subject_did")
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId)
    .in("subject_did", dids);
  if (existingError) {
    throw fromPostgres(existingError, "Could not read existing candidates.");
  }
  const existing = new Set(
    ((existingRows ?? []) as unknown as { subject_did: string }[]).map(
      (r) => r.subject_did,
    ),
  );

  const now = new Date().toISOString();
  const payload = input.followers.map((f) => ({
    workspace_id: input.workspaceId,
    operator_account_id: input.operatorAccountId,
    subject_did: f.did,
    handle: f.handle,
    display_name: f.displayName,
    avatar_url: f.avatarUrl,
    profile_refreshed_at: now,
    last_discovered_at: now,
    // first_discovered_at is deliberately omitted on conflict-update
    // below; Postgres upsert would otherwise reset it. It is only set
    // by the column default on a genuine insert.
  }));

  const { data, error } = await supabase
    .from("bluesky_candidates")
    .upsert(payload as never, {
      onConflict: "workspace_id,operator_account_id,subject_did",
    })
    .select("id, subject_did");
  if (error) throw fromPostgres(error, "Could not save candidates.");

  for (const row of (data ?? []) as unknown as {
    id: string;
    subject_did: string;
  }[]) {
    idsByDid.set(row.subject_did, row.id);
  }

  let created = 0;
  let updated = 0;
  for (const did of new Set(dids)) {
    if (existing.has(did)) updated += 1;
    else created += 1;
  }
  return { created, updated, idsByDid };
}

/**
 * Attribute candidates to the target profile they were found under.
 *
 * One row per (candidate, target). A candidate discovered under a
 * second target GAINS a row; it never replaces the first. `times_seen`
 * is incremented per re-sighting.
 *
 * Written as an upsert with `ignoreDuplicates: false` so a re-import
 * refreshes `last_seen_at` — but note `first_seen_at` is omitted, so
 * the original attribution instant is never overwritten.
 */
export async function recordCandidateSources(input: {
  workspaceId: string;
  targetProfileId: string;
  candidateIds: string[];
  db?: Db;
}): Promise<void> {
  if (input.candidateIds.length === 0) return;
  const supabase = client(input.db);
  const now = new Date().toISOString();

  // Read current counts so a re-sighting increments rather than resets.
  const { data: current, error: currentError } = await supabase
    .from("bluesky_candidate_sources")
    .select("candidate_id, times_seen")
    .eq("workspace_id", input.workspaceId)
    .eq("target_profile_id", input.targetProfileId)
    .in("candidate_id", input.candidateIds);
  if (currentError) {
    throw fromPostgres(currentError, "Could not read source attribution.");
  }
  const seen = new Map(
    ((current ?? []) as unknown as { candidate_id: string; times_seen: number }[]).map(
      (r) => [r.candidate_id, r.times_seen],
    ),
  );

  const { error } = await supabase.from("bluesky_candidate_sources").upsert(
    input.candidateIds.map((candidateId) => ({
      workspace_id: input.workspaceId,
      candidate_id: candidateId,
      target_profile_id: input.targetProfileId,
      last_seen_at: now,
      times_seen: (seen.get(candidateId) ?? 0) + 1,
    })) as never,
    { onConflict: "candidate_id,target_profile_id" },
  );
  if (error) throw fromPostgres(error, "Could not save source attribution.");
}

export interface CandidateWithSources extends BlueskyCandidateRow {
  /** Every target profile this DID has been discovered under. */
  sourceTargetProfileIds: string[];
}

export interface ListCandidatesFilter {
  workspaceId: string;
  operatorAccountId: string;
  states?: BlueskyRelationshipState[];
  protectedOnly?: boolean;
  targetProfileId?: string;
  search?: string;
  limit?: number;
  db?: Db;
}

/** One page of candidates plus the exact size of the full result set. */
export interface CandidatePage {
  rows: CandidateWithSources[];
  /**
   * Exact row count for the filter, from Postgres.
   *
   * NOT `rows.length`, and not a capped estimate. Deriving a total from
   * the current page is the defect this field exists to remove: a page
   * of 50 out of 4,000 would have reported "50 candidates".
   */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Exact per-state counts, for tab badges that must not lie. */
export interface CandidateStateCounts {
  total: number;
  unknown: number;
  not_following: number;
  following: number;
  follows_you: number;
  mutual: number;
  protectedCount: number;
}

export const CANDIDATE_PAGE_SIZE = 50;

/**
 * The subset of the PostgREST builder these queries need.
 *
 * Structural rather than `any`: the repo's ESLint config has no
 * typescript-eslint plugin, so a disable comment is itself a lint
 * error, and silencing a type is worse than describing one. Threading
 * Supabase's own generic builder type through these helpers instead
 * makes TypeScript recurse until it gives up ("type instantiation is
 * excessively deep"), so the builder is narrowed to this interface once
 * at each entry point and the row shape is asserted on the way out —
 * which is the same pattern the rest of this file already uses for
 * `data`.
 */
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

/** Narrow a Supabase builder to the shape these helpers use. */
function asFiltered(builder: unknown): FilteredQuery {
  return builder as FilteredQuery;
}

/**
 * Apply the filters shared by the page query and every count query.
 *
 * Extracted so a filter can never be applied to one and forgotten on
 * the other — which would make a count disagree with the rows beneath
 * it. Workspace and operator scope are applied here too, so no caller
 * can build a query that omits them.
 */
function applyCandidateFilters(
  query: FilteredQuery,
  filter: {
    workspaceId: string;
    operatorAccountId: string;
    states?: BlueskyRelationshipState[];
    protectedOnly?: boolean;
    search?: string;
  },
): FilteredQuery {
  let q = query
    .eq("workspace_id", filter.workspaceId)
    .eq("operator_account_id", filter.operatorAccountId);
  if (filter.states && filter.states.length > 0) {
    q = q.in("relationship_state", filter.states);
  }
  if (filter.protectedOnly) q = q.eq("protected", true);
  const term = filter.search?.trim();
  if (term) {
    // Handle and display name only. A partial DID match is meaningless
    // to a human, and the DID is not what anyone types.
    const like = `%${term}%`;
    q = q.or(`handle.ilike.${like},display_name.ilike.${like}`);
  }
  return q;
}

/**
 * One page of candidates, with an exact total.
 *
 * Two queries: the page itself, and a `head: true` exact count that
 * transfers no rows. Both go through `applyCandidateFilters`, so the
 * count always describes the same set the rows came from.
 */
export async function listCandidatesPage(
  filter: ListCandidatesFilter & { page?: number; pageSize?: number },
): Promise<CandidatePage> {
  const supabase = client(filter.db);
  const pageSize = Math.min(Math.max(filter.pageSize ?? CANDIDATE_PAGE_SIZE, 1), 200);
  const page = Math.max(filter.page ?? 1, 1);
  const from = (page - 1) * pageSize;

  const { count, error: countError } = await applyCandidateFilters(
    asFiltered(
      supabase
        .from("bluesky_candidates")
        .select("id", { count: "exact", head: true }),
    ),
    filter,
  );
  if (countError) throw fromPostgres(countError, "Could not count candidates.");
  const total = count ?? 0;

  const { data, error } = await applyCandidateFilters(
    asFiltered(supabase.from("bluesky_candidates").select("*")),
    filter,
  )
    // A stable tiebreaker after the timestamp: rows imported in the
    // same page share last_discovered_at to the millisecond, and
    // without a second key their order between requests is undefined —
    // which makes a row visible on two pages and invisible on none.
    .order("last_discovered_at", { ascending: false })
    .order("subject_did", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) throw fromPostgres(error, "Could not list candidates.");

  const rows = (data ?? []) as unknown as BlueskyCandidateRow[];
  const withSources = await attachSources(
    supabase,
    filter.workspaceId,
    rows,
    filter.targetProfileId,
  );

  return {
    rows: withSources,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Exact counts per relationship state.
 *
 * One `head: true` count per state rather than a GROUP BY, because
 * PostgREST cannot group without a database function and this milestone
 * adds no schema. Each is a count-only round trip that transfers no
 * rows, and the search filter is applied to all of them so the tab
 * badges describe what a search actually narrowed to.
 */
export async function countCandidatesByState(filter: {
  workspaceId: string;
  operatorAccountId: string;
  search?: string;
  db?: Db;
}): Promise<CandidateStateCounts> {
  const supabase = client(filter.db);

  const countWhere = async (
    extra?: { column: string; value: unknown },
  ): Promise<number> => {
    let q = applyCandidateFilters(
      asFiltered(
        supabase
          .from("bluesky_candidates")
          .select("id", { count: "exact", head: true }),
      ),
      filter,
    );
    if (extra) q = q.eq(extra.column, extra.value);
    const { count, error } = await q;
    if (error) throw fromPostgres(error, "Could not count candidates.");
    return count ?? 0;
  };

  const [total, unknown, notFollowing, following, followsYou, mutual, prot] =
    await Promise.all([
      countWhere(),
      countWhere({ column: "relationship_state", value: "unknown" }),
      countWhere({ column: "relationship_state", value: "not_following" }),
      countWhere({ column: "relationship_state", value: "following" }),
      countWhere({ column: "relationship_state", value: "follows_you" }),
      countWhere({ column: "relationship_state", value: "mutual" }),
      countWhere({ column: "protected", value: true }),
    ]);

  return {
    total,
    unknown,
    not_following: notFollowing,
    following,
    follows_you: followsYou,
    mutual,
    protectedCount: prot,
  };
}

/**
 * Attach source attribution to a page of candidates.
 *
 * The sources are a second query and grouped in memory, rather than an
 * embedded select, so a candidate with five sources comes back once
 * with five ids — not five times, and not once with one id.
 */
async function attachSources(
  supabase: SupabaseClient,
  workspaceId: string,
  rows: BlueskyCandidateRow[],
  targetProfileId?: string,
): Promise<CandidateWithSources[]> {
  if (rows.length === 0) return [];

  const { data: sourceRows, error } = await supabase
    .from("bluesky_candidate_sources")
    .select("candidate_id, target_profile_id")
    .eq("workspace_id", workspaceId)
    .in(
      "candidate_id",
      rows.map((r) => r.id),
    );
  if (error) throw fromPostgres(error, "Could not read source attribution.");

  const sources = new Map<string, string[]>();
  for (const row of (sourceRows ?? []) as unknown as {
    candidate_id: string;
    target_profile_id: string;
  }[]) {
    const list = sources.get(row.candidate_id) ?? [];
    // Defensive dedup: one (candidate, target) pair is unique in the
    // schema, but a candidate discovered under several targets must
    // still show each target exactly once.
    if (!list.includes(row.target_profile_id)) list.push(row.target_profile_id);
    sources.set(row.candidate_id, list);
  }

  const filtered = targetProfileId
    ? rows.filter((r) => (sources.get(r.id) ?? []).includes(targetProfileId))
    : rows;

  return filtered.map((row) => ({
    ...row,
    sourceTargetProfileIds: sources.get(row.id) ?? [],
  }));
}

/**
 * List candidates with their full source attribution.
 *
 * Unpaginated. Retained for callers that genuinely want a bounded slice
 * (the MCP read tools); the operator UI uses `listCandidatesPage`.
 */
export async function listCandidates(
  filter: ListCandidatesFilter,
): Promise<CandidateWithSources[]> {
  const supabase = client(filter.db);
  let query = supabase
    .from("bluesky_candidates")
    .select("*")
    .eq("workspace_id", filter.workspaceId)
    .eq("operator_account_id", filter.operatorAccountId);

  if (filter.states && filter.states.length > 0) {
    query = query.in("relationship_state", filter.states);
  }
  if (filter.protectedOnly) {
    query = query.eq("protected", true);
  }
  if (filter.search && filter.search.trim().length > 0) {
    const term = `%${filter.search.trim()}%`;
    query = query.or(
      `handle.ilike.${term},display_name.ilike.${term},subject_did.ilike.${term}`,
    );
  }

  const { data, error } = await query
    .order("last_discovered_at", { ascending: false })
    .limit(filter.limit ?? 200);
  if (error) throw fromPostgres(error, "Could not list candidates.");

  let rows = (data ?? []) as unknown as BlueskyCandidateRow[];
  if (rows.length === 0) return [];

  const { data: sourceRows, error: sourceError } = await supabase
    .from("bluesky_candidate_sources")
    .select("candidate_id, target_profile_id")
    .eq("workspace_id", filter.workspaceId)
    .in(
      "candidate_id",
      rows.map((r) => r.id),
    );
  if (sourceError) {
    throw fromPostgres(sourceError, "Could not read source attribution.");
  }

  const sources = new Map<string, string[]>();
  for (const row of (sourceRows ?? []) as unknown as {
    candidate_id: string;
    target_profile_id: string;
  }[]) {
    const list = sources.get(row.candidate_id) ?? [];
    list.push(row.target_profile_id);
    sources.set(row.candidate_id, list);
  }

  // Filtering by target AFTER grouping, so a candidate that also came
  // from other targets still shows all of its attributions.
  if (filter.targetProfileId) {
    const target = filter.targetProfileId;
    rows = rows.filter((r) => (sources.get(r.id) ?? []).includes(target));
  }

  return rows.map((row) => ({
    ...row,
    sourceTargetProfileIds: sources.get(row.id) ?? [],
  }));
}

export async function getCandidatesByIds(
  workspaceId: string,
  operatorAccountId: string,
  candidateIds: string[],
  db?: Db,
): Promise<BlueskyCandidateRow[]> {
  if (candidateIds.length === 0) return [];
  const { data, error } = await client(db)
    .from("bluesky_candidates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("operator_account_id", operatorAccountId)
    .in("id", candidateIds);
  if (error) throw fromPostgres(error, "Could not read candidates.");
  return (data ?? []) as unknown as BlueskyCandidateRow[];
}

export async function getCandidateSourceIds(
  workspaceId: string,
  candidateId: string,
  db?: Db,
): Promise<string[]> {
  const { data, error } = await client(db)
    .from("bluesky_candidate_sources")
    .select("target_profile_id")
    .eq("workspace_id", workspaceId)
    .eq("candidate_id", candidateId);
  if (error) throw fromPostgres(error, "Could not read source attribution.");
  return ((data ?? []) as unknown as { target_profile_id: string }[]).map(
    (r) => r.target_profile_id,
  );
}

export interface UpdateRelationshipStateInput {
  workspaceId: string;
  operatorAccountId: string;
  subjectDid: string;
  state: BlueskyRelationshipState;
  /** Non-null ONLY when the lookup itself failed. */
  error?: string | null;
  followUri?: string | null;
  followRkey?: string | null;
  followCid?: string | null;
  followRecordSource?: BlueskyFollowRecordSource | null;
  followedAt?: string | null;
  unfollowedAt?: string | null;
  db?: Db;
}

/**
 * Write an observed relationship state onto a candidate.
 *
 * The caller supplies the state. There is no branch here that turns a
 * failure into `not_following`: an upstream failure arrives as
 * `unknown` plus an `error` string, and that is what gets stored.
 *
 * Follow-record columns are only touched when the caller passes them,
 * so a routine relationship refresh does not wipe an rkey that a
 * previous follow captured.
 */
export async function updateCandidateRelationship(
  input: UpdateRelationshipStateInput,
): Promise<void> {
  const patch: Record<string, unknown> = {
    relationship_state: input.state,
    relationship_checked_at: new Date().toISOString(),
    relationship_error: input.error ?? null,
  };
  if (input.followUri !== undefined) patch.follow_uri = input.followUri;
  if (input.followRkey !== undefined) patch.follow_rkey = input.followRkey;
  if (input.followCid !== undefined) patch.follow_cid = input.followCid;
  if (input.followRecordSource !== undefined) {
    patch.follow_record_source = input.followRecordSource;
  }
  if (input.followedAt !== undefined) patch.followed_at = input.followedAt;
  if (input.unfollowedAt !== undefined) patch.unfollowed_at = input.unfollowedAt;

  const { error } = await client(input.db)
    .from("bluesky_candidates")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId)
    .eq("subject_did", input.subjectDid);
  if (error) throw fromPostgres(error, "Could not update relationship state.");
}

export async function setCandidateProtected(input: {
  workspaceId: string;
  operatorAccountId: string;
  candidateId: string;
  protectedValue: boolean;
  actorUserId: string | null;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_candidates")
    .update({
      protected: input.protectedValue,
      protected_at: input.protectedValue ? new Date().toISOString() : null,
      protected_by: input.protectedValue ? input.actorUserId : null,
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId)
    .eq("id", input.candidateId);
  if (error) throw fromPostgres(error, "Could not update protection.");
}

// =====================================================================
// Batches
// =====================================================================

export interface CreateBatchInput {
  workspaceId: string;
  operatorAccountId: string;
  actionType: BlueskyActionType;
  createdBy: string | null;
  db?: Db;
}

export async function createBatch(
  input: CreateBatchInput,
): Promise<BlueskyActionBatchRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_action_batches")
    .insert({
      workspace_id: input.workspaceId,
      operator_account_id: input.operatorAccountId,
      action_type: input.actionType,
      status: "pending",
      created_by: input.createdBy,
    } as never)
    .select("*")
    .single();
  if (error) throw fromPostgres(error, "Could not create the batch.");
  return data as unknown as BlueskyActionBatchRow;
}

/**
 * Freeze a batch's membership.
 *
 * After this returns, the trigger on `bluesky_relationship_actions`
 * refuses any further INSERT carrying this batch id. `requestedCount`
 * is stamped from the rows that exist at this instant, so a later
 * count mismatch is detectable.
 */
export async function confirmBatch(input: {
  workspaceId: string;
  batchId: string;
  requestedCount: number;
  confirmedBy: string | null;
  db?: Db;
}): Promise<BlueskyActionBatchRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_action_batches")
    .update({
      status: "confirmed",
      requested_count: input.requestedCount,
      confirmed_at: new Date().toISOString(),
      confirmed_by: input.confirmedBy,
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.batchId)
    // Only a not-yet-confirmed batch may be confirmed. Re-confirming
    // would move confirmed_at forward and re-open the window the
    // trigger closes.
    .is("confirmed_at", null)
    .select("*")
    .single();
  if (error) throw fromPostgres(error, "Could not confirm the batch.");
  if (!data) throw notFound("Batch");
  return data as unknown as BlueskyActionBatchRow;
}

export async function getBatch(
  workspaceId: string,
  batchId: string,
  db?: Db,
): Promise<BlueskyActionBatchRow | null> {
  const { data, error } = await client(db)
    .from("bluesky_action_batches")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", batchId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read the batch.");
  return (data as unknown as BlueskyActionBatchRow) ?? null;
}

export async function updateBatchProgress(input: {
  workspaceId: string;
  batchId: string;
  status: BlueskyActionBatchRow["status"];
  processed: number;
  succeeded: number;
  failed: number;
  reconciliationRequired: number;
  stopReason?: string | null;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  db?: Db;
}): Promise<void> {
  const { error } = await client(input.db)
    .from("bluesky_action_batches")
    .update({
      status: input.status,
      processed_count: input.processed,
      succeeded_count: input.succeeded,
      failed_count: input.failed,
      reconciliation_required_count: input.reconciliationRequired,
      ...(input.stopReason !== undefined ? { stop_reason: input.stopReason } : {}),
      ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
      ...(input.startedAt !== undefined ? { started_at: input.startedAt } : {}),
      ...(input.finishedAt !== undefined ? { finished_at: input.finishedAt } : {}),
    } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.batchId);
  if (error) throw fromPostgres(error, "Could not update batch progress.");
}

export async function listBatches(
  workspaceId: string,
  operatorAccountId: string,
  limit = 25,
  db?: Db,
): Promise<BlueskyActionBatchRow[]> {
  const { data, error } = await client(db)
    .from("bluesky_action_batches")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("operator_account_id", operatorAccountId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw fromPostgres(error, "Could not list batches.");
  return (data ?? []) as unknown as BlueskyActionBatchRow[];
}

// =====================================================================
// Actions
// =====================================================================

export interface CreateActionInput {
  workspaceId: string;
  operatorAccountId: string;
  candidateId: string | null;
  batchId: string | null;
  actionType: BlueskyActionType;
  subjectDid: string;
  /** Frozen at request time. Never backfilled from the current handle. */
  subjectHandleAtAction: string | null;
  actorDid: string | null;
  actorHandleAtAction: string | null;
  sourceTargetProfileIds: string[];
  initiatedBy: string | null;
  initiatorKind: "operator_single" | "operator_batch";
  db?: Db;
}

/**
 * Claim an action.
 *
 * The insert lands as `pending`, which is covered by the partial unique
 * index over (workspace, identity, subject, type) where status is
 * pending/running. A second concurrent claim for the same target fails
 * at the database rather than racing through an application check — the
 * reason being that `createRecord` would happily mint two follow
 * records for one account.
 */
export async function createAction(
  input: CreateActionInput,
): Promise<BlueskyRelationshipActionRow> {
  const { data, error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .insert({
      workspace_id: input.workspaceId,
      operator_account_id: input.operatorAccountId,
      candidate_id: input.candidateId,
      batch_id: input.batchId,
      action_type: input.actionType,
      subject_did: input.subjectDid,
      subject_handle_at_action: input.subjectHandleAtAction,
      actor_did: input.actorDid,
      actor_handle_at_action: input.actorHandleAtAction,
      status: "pending",
      source_target_profile_ids: input.sourceTargetProfileIds,
      initiated_by: input.initiatedBy,
      initiator_kind: input.initiatorKind,
    } as never)
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateActiveActionError(input.subjectDid, input.actionType);
    }
    if (mentionsFrozenBatch(error)) {
      throw new BatchMembershipFrozenError(input.batchId ?? "(unknown)");
    }
    throw fromPostgres(error, "Could not record the relationship action.");
  }
  return data as unknown as BlueskyRelationshipActionRow;
}

export interface UpdateActionInput {
  workspaceId: string;
  actionId: string;
  status: BlueskyActionStatus;
  followUri?: string | null;
  followRkey?: string | null;
  followCid?: string | null;
  providerStatusCode?: number | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  reconciledState?: BlueskyRelationshipState | null;
  reconciledAt?: string | null;
  reconciliationNote?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  db?: Db;
}

/**
 * Advance an action's state.
 *
 * `batch_id` is never in the patch. The trigger refuses to move an
 * action between batches, and omitting the column means the application
 * cannot even attempt it.
 */
export async function updateAction(input: UpdateActionInput): Promise<void> {
  const patch: Record<string, unknown> = { status: input.status };
  const maybe = <K extends keyof UpdateActionInput>(key: K, column: string) => {
    if (input[key] !== undefined) patch[column] = input[key];
  };
  maybe("followUri", "follow_uri");
  maybe("followRkey", "follow_rkey");
  maybe("followCid", "follow_cid");
  maybe("providerStatusCode", "provider_status_code");
  maybe("providerErrorCode", "provider_error_code");
  maybe("providerErrorMessage", "provider_error_message");
  maybe("reconciledState", "reconciled_state");
  maybe("reconciledAt", "reconciled_at");
  maybe("reconciliationNote", "reconciliation_note");
  maybe("startedAt", "started_at");
  maybe("finishedAt", "finished_at");

  const { error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.actionId);
  if (error) throw fromPostgres(error, "Could not update the action.");
}

export async function listBatchActions(
  workspaceId: string,
  batchId: string,
  db?: Db,
): Promise<BlueskyRelationshipActionRow[]> {
  const { data, error } = await client(db)
    .from("bluesky_relationship_actions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("batch_id", batchId)
    .order("requested_at", { ascending: true });
  if (error) throw fromPostgres(error, "Could not read batch actions.");
  return (data ?? []) as unknown as BlueskyRelationshipActionRow[];
}

/** One page of history plus the exact number of actions recorded. */
export interface ActionHistoryPage {
  rows: BlueskyRelationshipActionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const HISTORY_PAGE_SIZE = 25;

/**
 * One page of the audit trail, with an exact total.
 *
 * History only grows — an unfollow adds a row rather than retracting a
 * follow — so this is the list most certain to outrun any fixed limit.
 */
export async function listActionHistoryPage(input: {
  workspaceId: string;
  operatorAccountId: string;
  subjectDid?: string;
  page?: number;
  pageSize?: number;
  db?: Db;
}): Promise<ActionHistoryPage> {
  const supabase = client(input.db);
  const pageSize = Math.min(Math.max(input.pageSize ?? HISTORY_PAGE_SIZE, 1), 200);
  const page = Math.max(input.page ?? 1, 1);
  const from = (page - 1) * pageSize;

  const scope = (q: FilteredQuery): FilteredQuery => {
    let out = q
      .eq("workspace_id", input.workspaceId)
      .eq("operator_account_id", input.operatorAccountId);
    if (input.subjectDid) out = out.eq("subject_did", input.subjectDid);
    return out;
  };

  const { count, error: countError } = await scope(
    asFiltered(
      supabase
        .from("bluesky_relationship_actions")
        .select("id", { count: "exact", head: true }),
    ),
  );
  if (countError) throw fromPostgres(countError, "Could not count history.");

  const { data, error } = await scope(
    asFiltered(supabase.from("bluesky_relationship_actions").select("*")),
  )
    .order("requested_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) throw fromPostgres(error, "Could not read relationship history.");

  const total = count ?? 0;
  return {
    rows: (data ?? []) as unknown as BlueskyRelationshipActionRow[],
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * How many actions are sitting in `reconciliation_required`.
 *
 * Counted across the whole history rather than the visible page: it is
 * a standing condition the operator must not be able to page past, so
 * the banner that reports it has to be independent of pagination.
 */
export async function countActionsNeedingReconciliation(input: {
  workspaceId: string;
  operatorAccountId: string;
  db?: Db;
}): Promise<number> {
  const { count, error } = await client(input.db)
    .from("bluesky_relationship_actions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId)
    .eq("status", "reconciliation_required");
  if (error) throw fromPostgres(error, "Could not count reconciliations.");
  return count ?? 0;
}

export async function listActionHistory(input: {
  workspaceId: string;
  operatorAccountId: string;
  subjectDid?: string;
  limit?: number;
  db?: Db;
}): Promise<BlueskyRelationshipActionRow[]> {
  let query = client(input.db)
    .from("bluesky_relationship_actions")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("operator_account_id", input.operatorAccountId);
  if (input.subjectDid) query = query.eq("subject_did", input.subjectDid);

  const { data, error } = await query
    .order("requested_at", { ascending: false })
    .limit(input.limit ?? 100);
  if (error) throw fromPostgres(error, "Could not read relationship history.");
  return (data ?? []) as unknown as BlueskyRelationshipActionRow[];
}

export type { BlueskyCandidateSourceRow };
