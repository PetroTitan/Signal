import "server-only";
/**
 * Durable import progress for a campaign queue.
 *
 * The old import walked the candidate corpus with OFFSET and stopped
 * after a bounded number of pages. Continuing meant handing the page
 * number back in — and the only thing that knew it was the browser,
 * which never sent it. Every invocation restarted at page 1, so a
 * corpus past ~10,000 could never finish: the same first rows imported
 * again and again while the rest were never reached.
 *
 * Progress therefore lives here, in the database, as a keyset
 * checkpoint on a job row. The browser supplies nothing. A refresh
 * loses nothing. A crash resumes from the last committed window.
 *
 * OFFSET would be wrong even with the page number fixed: it is
 * O(offset) per page, and it is unstable while rows are being written,
 * so a candidate discovered mid-import shifts every later page and rows
 * are skipped and re-read at random. The keyset order —
 * `(last_discovered_at desc, subject_did asc)` — is total, because the
 * DID is unique within (workspace, identity), and it is stable under
 * concurrent writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import { fromPostgres } from "./errors";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

/** The relationship states a campaign may follow from. */
export const IMPORTABLE_STATES = [
  "unknown",
  "not_following",
  "follows_you",
] as const;

export type ImportSourceKind = "candidates" | "target_followers";

export interface ImportJob {
  jobId: string;
  status: "running" | "ready" | "failed";
  sourceKind: ImportSourceKind;
  targetProfileId: string | null;
  cursorLastDiscoveredAt: string | null;
  cursorSubjectDid: string | null;
  providerCursor: string | null;
  sourceExhausted: boolean;
  importedCount: number;
  duplicateCount: number;
  excludedCount: number;
  /**
   * Set when the call was refused rather than fulfilled. The only
   * refusal in normal operation is `source_mismatch`: a campaign's
   * queue is built from ONE list, and half from one target plus half
   * from another is not something an operator can reason about.
   */
  refusedReason: string | null;
}

function toJob(row: Record<string, unknown>): ImportJob {
  return {
    jobId: String(row.out_job_id ?? row.job_id ?? row.id ?? ""),
    status: ((row.out_status ?? row.status) as ImportJob["status"]) ?? "running",
    sourceKind:
      ((row.out_source_kind ?? row.source_kind) as ImportSourceKind) ??
      "candidates",
    targetProfileId:
      ((row.out_target_profile_id ?? row.target_profile_id) as string | null) ??
      null,
    cursorLastDiscoveredAt:
      ((row.out_cursor_at ?? row.cursor_last_discovered_at) as string | null) ??
      null,
    cursorSubjectDid:
      ((row.out_cursor_did ?? row.cursor_subject_did) as string | null) ?? null,
    providerCursor:
      ((row.out_provider_cursor ?? row.provider_cursor) as string | null) ?? null,
    sourceExhausted:
      (row.out_source_exhausted ?? row.source_exhausted) === true,
    importedCount: Number(row.out_imported ?? row.imported_count ?? 0),
    duplicateCount: Number(row.out_duplicates ?? row.duplicate_count ?? 0),
    excludedCount: Number(row.out_excluded ?? row.excluded_count ?? 0),
    refusedReason:
      ((row.out_refused_reason ?? row.refused_reason) as string | null) ?? null,
  };
}

/** Open the campaign's import job, or resume the one already there. */
export async function beginImportJob(input: {
  workspaceId: string;
  campaignId: string;
  sourceKind: ImportSourceKind;
  targetProfileId: string | null;
  db?: Db;
}): Promise<ImportJob> {
  const { data, error } = await client(input.db).rpc(
    "begin_bluesky_campaign_import",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_source_kind: input.sourceKind,
      p_target_profile_id: input.targetProfileId,
    },
  );
  if (error) throw fromPostgres(error, "Could not start the import.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw fromPostgres(null, "Could not start the import.");
  return toJob(row);
}

/**
 * Commit one window of progress.
 *
 * The checkpoint only ever moves forward. Two callers that read the
 * same checkpoint do the same work — harmless, because the unique index
 * on (campaign_id, subject_did) is what actually deduplicates — and the
 * slower one's attempt to rewind is ignored. A repeated, retried or
 * concurrent import can duplicate effort but never a member, and can
 * never skip one.
 */
export async function advanceImportJob(input: {
  workspaceId: string;
  jobId: string;
  cursorLastDiscoveredAt: string | null;
  cursorSubjectDid: string | null;
  providerCursor: string | null;
  inserted: number;
  duplicates: number;
  excluded: number;
  pages: number;
  sourceExhausted: boolean;
  error: string | null;
  db?: Db;
}): Promise<ImportJob | null> {
  const { data, error } = await client(input.db).rpc(
    "advance_bluesky_campaign_import",
    {
      p_workspace_id: input.workspaceId,
      p_job_id: input.jobId,
      p_cursor_last_discovered_at: input.cursorLastDiscoveredAt,
      p_cursor_subject_did: input.cursorSubjectDid,
      p_provider_cursor: input.providerCursor,
      p_inserted: input.inserted,
      p_duplicates: input.duplicates,
      p_excluded: input.excluded,
      p_pages: input.pages,
      p_source_exhausted: input.sourceExhausted,
      p_error: input.error,
    },
  );
  if (error) throw fromPostgres(error, "Could not record import progress.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return toJob({ ...row, out_job_id: input.jobId, out_source_kind: "candidates" });
}

/** The campaign's import job as the operator should see it. */
export async function getImportJob(input: {
  workspaceId: string;
  campaignId: string;
  db?: Db;
}): Promise<
  | (ImportJob & { pagesRead: number; lastError: string | null })
  | null
> {
  const { data, error } = await client(input.db)
    .from("bluesky_campaign_import_jobs")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Could not read import progress.");
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return {
    ...toJob({ ...row, job_id: row.id }),
    pagesRead: Number(row.pages_read ?? 0),
    lastError: (row.last_error as string | null) ?? null,
  };
}

export interface KeysetCandidate {
  subject_did: string;
  handle: string | null;
  display_name: string | null;
  last_discovered_at: string;
  protected: boolean;
}

/**
 * One keyset window of the candidate corpus, in the total order.
 *
 * Bounded by construction: the RPC caps the limit, and nothing here
 * accumulates. A 100,000-row source is hundreds of these, each one read
 * and forgotten.
 */
export async function listCandidatesKeyset(input: {
  workspaceId: string;
  operatorAccountId: string;
  states?: readonly string[];
  targetProfileId?: string | null;
  afterLastDiscoveredAt?: string | null;
  afterSubjectDid?: string | null;
  limit: number;
  db?: Db;
}): Promise<KeysetCandidate[]> {
  const { data, error } = await client(input.db).rpc(
    "list_bluesky_candidates_keyset",
    {
      p_workspace_id: input.workspaceId,
      p_operator_account_id: input.operatorAccountId,
      p_states: (input.states ?? IMPORTABLE_STATES) as string[],
      p_target_profile_id: input.targetProfileId ?? null,
      p_after_last_discovered_at: input.afterLastDiscoveredAt ?? null,
      p_after_subject_did: input.afterSubjectDid ?? null,
      p_limit: input.limit,
    },
  );
  if (error) throw fromPostgres(error, "Could not read candidates.");
  return (data ?? []) as unknown as KeysetCandidate[];
}

export interface EligibleCount {
  eligible: number;
  protectedExcluded: number;
}

/**
 * How many profiles a source would actually queue.
 *
 * Counted in the database. The setup screen shows an exact number for a
 * 100,000-row source, and reading the rows to find out would defeat the
 * point of the screen.
 */
export async function countEligibleCandidates(input: {
  workspaceId: string;
  operatorAccountId: string;
  states?: readonly string[];
  targetProfileId?: string | null;
  db?: Db;
}): Promise<EligibleCount> {
  const { data, error } = await client(input.db).rpc(
    "count_bluesky_candidates_eligible",
    {
      p_workspace_id: input.workspaceId,
      p_operator_account_id: input.operatorAccountId,
      p_states: (input.states ?? IMPORTABLE_STATES) as string[],
      p_target_profile_id: input.targetProfileId ?? null,
    },
  );
  if (error) throw fromPostgres(error, "Could not count candidates.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { eligible: number; protected_excluded: number }
    | undefined;
  return {
    eligible: Number(row?.eligible ?? 0),
    protectedExcluded: Number(row?.protected_excluded ?? 0),
  };
}
