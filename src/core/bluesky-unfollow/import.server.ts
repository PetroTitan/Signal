import "server-only";
/**
 * Building an unfollow queue, durably and restartably.
 *
 * ONE BOUNDED UNIT OF WORK PER CALL. The caller invokes this as many
 * times as it takes; where to continue from is the database's business,
 * never the browser's. A 100,000-profile list is therefore built by N
 * short server calls, each of which commits its own progress, and
 * losing the tab, the server, or the deploy costs at most the page in
 * flight.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 *   • No array of every member. Nothing in this module holds more than
 *     one page, and the page size is a constant.
 *   • No OFFSET. Database sources walk by keyset on `subject_did`, a
 *     total order whose tie-breaker is the key itself; the provider
 *     source walks by the provider's own cursor.
 *   • No inference that a short page means the end. `source_exhausted`
 *     is set only when the source SAYS it has no more — a short page
 *     from `listRecords` is routine.
 *   • No provider mutation of any kind. Building a queue is reading.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listFollowRecords,
  LIST_RECORDS_MAX_LIMIT,
} from "@/core/bluesky-relationships/atproto-graph";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  importUnfollowChunk,
  listSourcePage,
  UNFOLLOW_IMPORT_CHUNK_SIZE,
  type ImportMemberRow,
  type UnfollowSourceKind,
} from "@/repositories/bluesky-unfollow-repository";
import { fromPostgres } from "@/repositories/errors";
import { createSupabaseServerClient } from "@/lib/supabase";

type Db = SupabaseClient | undefined;
const client = (db: Db): SupabaseClient => db ?? createSupabaseServerClient();

/**
 * Pages read per invocation.
 *
 * Bounded so one call cannot outlive a server-action timeout. Six pages
 * of 500 is 3,000 profiles per call for a database source; for the
 * provider source it is six `listRecords` calls of 100, spaced, which
 * is 600. A 100,000 list is therefore tens of calls, each of which
 * commits — which is the point.
 */
export const MAX_PAGES_PER_INVOCATION = 6;

/**
 * Courtesy spacing between provider pages.
 *
 * `listRecords` is a read against the account's PDS and counts toward
 * the 3,000-requests-per-5-minutes IP limit, not the write budget. This
 * is pacing, not evasion: it is fixed, it is not randomised, and it is
 * not there to look like anything.
 */
export const PROVIDER_PAGE_SPACING_MS = 250;

export interface ImportProgress {
  jobId: string | null;
  status: "running" | "ready" | "failed";
  campaignStatus: string | null;
  totalImported: number;
  totalDuplicates: number;
  totalProtected: number;
  complete: boolean;
  error: string | null;
}

export interface ResumeImportInput {
  workspaceId: string;
  campaignId: string;
  operatorAccountId: string;
  sourceKind: UnfollowSourceKind;
  targetProfileId: string | null;
  sourceCampaignId: string | null;
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}

interface JobState {
  jobId: string;
  status: string;
  cursorDid: string | null;
  providerCursor: string | null;
  sourceExhausted: boolean;
  imported: number;
  duplicates: number;
  excluded: number;
}

async function beginJob(
  input: ResumeImportInput,
): Promise<JobState | { refused: string }> {
  const { data, error } = await client(input.db).rpc(
    "begin_bluesky_unfollow_import",
    {
      p_workspace_id: input.workspaceId,
      p_campaign_id: input.campaignId,
      p_source_kind: input.sourceKind,
      p_target_profile_id: input.targetProfileId,
      p_source_campaign_id: input.sourceCampaignId,
    },
  );
  if (error) throw fromPostgres(error, "Could not start building the list.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_job_id: string | null;
        out_status: string | null;
        out_cursor_did: string | null;
        out_provider_cursor: string | null;
        out_source_exhausted: boolean | null;
        out_imported: number | null;
        out_duplicates: number | null;
        out_excluded: number | null;
        out_refused_reason: string | null;
      }
    | undefined;
  if (!row || row.out_refused_reason) {
    return { refused: row?.out_refused_reason ?? "unknown" };
  }
  return {
    jobId: row.out_job_id as string,
    status: row.out_status ?? "running",
    cursorDid: row.out_cursor_did,
    providerCursor: row.out_provider_cursor,
    sourceExhausted: row.out_source_exhausted === true,
    imported: Number(row.out_imported ?? 0),
    duplicates: Number(row.out_duplicates ?? 0),
    excluded: Number(row.out_excluded ?? 0),
  };
}

async function advanceJob(
  input: ResumeImportInput,
  jobId: string,
  patch: {
    cursorDid: string | null;
    providerCursor: string | null;
    inserted: number;
    duplicates: number;
    excluded: number;
    pages: number;
    sourceExhausted: boolean;
    error: string | null;
  },
): Promise<{
  status: "running" | "ready" | "failed";
  campaignStatus: string | null;
  imported: number;
  duplicates: number;
  excluded: number;
  sourceExhausted: boolean;
  cursorDid: string | null;
  providerCursor: string | null;
}> {
  const { data, error } = await client(input.db).rpc(
    "advance_bluesky_unfollow_import",
    {
      p_workspace_id: input.workspaceId,
      p_job_id: jobId,
      p_cursor_subject_did: patch.cursorDid,
      p_provider_cursor: patch.providerCursor,
      p_inserted: patch.inserted,
      p_duplicates: patch.duplicates,
      p_excluded: patch.excluded,
      p_pages: patch.pages,
      p_source_exhausted: patch.sourceExhausted,
      p_error: patch.error,
    },
  );
  if (error) throw fromPostgres(error, "Could not save the list progress.");
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_status: string;
        out_cursor_did: string | null;
        out_provider_cursor: string | null;
        out_source_exhausted: boolean;
        out_imported: number;
        out_duplicates: number;
        out_excluded: number;
        out_campaign_status: string | null;
      }
    | undefined;
  return {
    status: (row?.out_status ?? "running") as "running" | "ready" | "failed",
    campaignStatus: row?.out_campaign_status ?? null,
    imported: Number(row?.out_imported ?? 0),
    duplicates: Number(row?.out_duplicates ?? 0),
    excluded: Number(row?.out_excluded ?? 0),
    sourceExhausted: row?.out_source_exhausted === true,
    cursorDid: row?.out_cursor_did ?? null,
    providerCursor: row?.out_provider_cursor ?? null,
  };
}

/**
 * Continue building the queue.
 *
 * Safe to call concurrently. Two callers may read the same page and do
 * the same work twice; neither can add a member twice (the unique
 * `(campaign_id, subject_did)` absorbs the overlap) and neither can
 * rewind the other's cursor.
 */
export async function resumeUnfollowImport(
  input: ResumeImportInput,
): Promise<ImportProgress> {
  const opened = await beginJob(input);
  if ("refused" in opened) {
    return {
      jobId: null,
      status: "failed",
      campaignStatus: null,
      totalImported: 0,
      totalDuplicates: 0,
      totalProtected: 0,
      complete: false,
      error: refusalMessage(opened.refused),
    };
  }

  if (opened.sourceExhausted) {
    return {
      jobId: opened.jobId,
      status: "ready",
      campaignStatus: "ready",
      totalImported: opened.imported,
      totalDuplicates: opened.duplicates,
      totalProtected: opened.excluded,
      complete: true,
      error: null,
    };
  }

  return input.sourceKind === "following_records"
    ? walkOwnRepository(input, opened)
    : walkDatabaseSource(input, opened);
}

function refusalMessage(code: string): string {
  switch (code) {
    case "queue_frozen":
      return "This campaign's list is already final and cannot be changed. Create a new campaign to unfollow a different set.";
    case "source_locked":
      return "This campaign is already being built from a different list. A campaign uses one source, never a mixture.";
    case "wrong_campaign_kind":
      return "That campaign is not an unfollow campaign.";
    case "unknown_campaign":
      return "That campaign is not in your workspace.";
    case "workspace_mismatch":
      return "That list belongs to a different workspace.";
    default:
      return "The list could not be built.";
  }
}

/**
 * Database-backed sources: candidates, one imported list, or a Signal
 * follow campaign's successes.
 *
 * Walks by keyset on `subject_did`. The record identity travels with
 * each row, so the queue knows which record to delete before the
 * campaign ever runs — and the worker still re-reads it at execution
 * time, because a key stored today can be stale next week.
 */
async function walkDatabaseSource(
  input: ResumeImportInput,
  job: JobState,
): Promise<ImportProgress> {
  const session = await resolveActorDid(input);
  if ("error" in session) {
    const failed = await advanceJob(input, job.jobId, {
      cursorDid: null,
      providerCursor: null,
      inserted: 0,
      duplicates: 0,
      excluded: 0,
      pages: 0,
      sourceExhausted: false,
      error: session.error,
    });
    return toProgress(job.jobId, failed, session.error);
  }

  let cursor = job.cursorDid;
  let inserted = 0;
  let duplicates = 0;
  let protectedCount = 0;
  let pages = 0;
  let exhausted = false;
  const maxPages = input.maxPages ?? MAX_PAGES_PER_INVOCATION;

  while (pages < maxPages) {
    const rows = await listSourcePage({
      workspaceId: input.workspaceId,
      operatorAccountId: input.operatorAccountId,
      sourceKind: input.sourceKind as Exclude<
        UnfollowSourceKind,
        "following_records"
      >,
      targetProfileId: input.targetProfileId,
      sourceCampaignId: input.sourceCampaignId,
      afterDid: cursor,
      limit: UNFOLLOW_IMPORT_CHUNK_SIZE,
      db: input.db,
    });
    pages += 1;

    if (rows.length === 0) {
      // A database source is finite and fully ordered, so an empty page
      // IS the end. (This is exactly the inference that would be wrong
      // for a provider walk, which is why the two are separate paths.)
      exhausted = true;
      break;
    }

    const members: ImportMemberRow[] = rows.map((r) => ({
      subject_did: r.subjectDid,
      current_handle: r.currentHandle,
      display_name: r.displayName,
      record_uri: r.recordUri,
      record_rkey: r.recordRkey,
      record_cid: r.recordCid,
      record_source: "relationship_read",
    }));

    const result = await importUnfollowChunk({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      operatorAccountId: input.operatorAccountId,
      actorDid: session.actorDid,
      members,
      db: input.db,
    });

    inserted += result.inserted;
    duplicates += result.duplicates;
    protectedCount += result.protectedCount;
    // Advance past the LAST DID READ, not the last inserted. A page
    // that was entirely duplicates would otherwise loop forever.
    cursor = result.lastDid ?? rows[rows.length - 1].subjectDid;

    if (rows.length < UNFOLLOW_IMPORT_CHUNK_SIZE) {
      exhausted = true;
      break;
    }
  }

  const advanced = await advanceJob(input, job.jobId, {
    cursorDid: cursor,
    providerCursor: null,
    inserted,
    duplicates,
    excluded: protectedCount,
    pages,
    sourceExhausted: exhausted,
    error: null,
  });
  return toProgress(job.jobId, advanced, null);
}

/**
 * The acting repository's own follow records.
 *
 * `com.atproto.repo.listRecords` rather than `getFollows`, because this
 * is the only source that returns the thing an unfollow needs: the
 * record's own URI and CID, in the operator's own repo. The AppView's
 * index of the graph would give profiles and lag writes.
 *
 * `exhausted` comes from the PROVIDER's cursor being absent. A short
 * page is not the end of a repository listing, and inferring otherwise
 * is how an import silently stops at 40% and calls itself complete.
 */
async function walkOwnRepository(
  input: ResumeImportInput,
  job: JobState,
): Promise<ImportProgress> {
  const resolved = await resolveRelationshipSession({
    workspaceId: input.workspaceId,
    accountId: input.operatorAccountId,
    db: input.db,
  });
  if (!resolved.ok) {
    const failed = await advanceJob(input, job.jobId, {
      cursorDid: null,
      providerCursor: null,
      inserted: 0,
      duplicates: 0,
      excluded: 0,
      pages: 0,
      sourceExhausted: false,
      error: resolved.message,
    });
    return toProgress(job.jobId, failed, resolved.message);
  }

  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let cursor = job.providerCursor;
  let inserted = 0;
  let duplicates = 0;
  let protectedCount = 0;
  let pages = 0;
  let exhausted = false;
  const maxPages = input.maxPages ?? MAX_PAGES_PER_INVOCATION;

  while (pages < maxPages) {
    const page = await listFollowRecords({
      accessJwt: resolved.accessJwt,
      actorDid: resolved.actorDid,
      limit: LIST_RECORDS_MAX_LIMIT,
      cursor,
      pds: resolved.service,
      fetchImpl: input.fetchImpl,
    });
    pages += 1;

    if (!page.ok) {
      // Progress made SO FAR is committed before the failure is
      // recorded, so a provider hiccup at page 40 does not discard 39
      // pages of work.
      const failed = await advanceJob(input, job.jobId, {
        cursorDid: null,
        providerCursor: cursor,
        inserted,
        duplicates,
        excluded: protectedCount,
        pages,
        sourceExhausted: false,
        error: page.message,
      });
      return toProgress(job.jobId, failed, page.message);
    }

    const members: ImportMemberRow[] = page.page.records.map((r) => ({
      subject_did: r.subjectDid,
      current_handle: null,
      display_name: null,
      record_uri: r.uri,
      record_rkey: r.rkey,
      record_cid: r.cid,
      // Read from the acting repository itself — the strongest
      // provenance available for a delete target.
      record_source: "list_records",
    }));

    if (members.length > 0) {
      const result = await importUnfollowChunk({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        operatorAccountId: input.operatorAccountId,
        actorDid: resolved.actorDid,
        members,
        db: input.db,
      });
      inserted += result.inserted;
      duplicates += result.duplicates;
      protectedCount += result.protectedCount;
    }

    cursor = page.page.cursor;
    if (page.page.exhausted) {
      exhausted = true;
      break;
    }
    if (pages < maxPages) await sleep(PROVIDER_PAGE_SPACING_MS);
  }

  const advanced = await advanceJob(input, job.jobId, {
    cursorDid: null,
    providerCursor: cursor,
    inserted,
    duplicates,
    excluded: protectedCount,
    pages,
    sourceExhausted: exhausted,
    error: null,
  });
  return toProgress(job.jobId, advanced, null);
}

async function resolveActorDid(
  input: ResumeImportInput,
): Promise<{ actorDid: string } | { error: string }> {
  const resolved = await resolveRelationshipSession({
    workspaceId: input.workspaceId,
    accountId: input.operatorAccountId,
    db: input.db,
  });
  if (!resolved.ok) return { error: resolved.message };
  return { actorDid: resolved.actorDid };
}

function toProgress(
  jobId: string,
  advanced: {
    status: "running" | "ready" | "failed";
    campaignStatus: string | null;
    imported: number;
    duplicates: number;
    excluded: number;
    sourceExhausted: boolean;
  },
  error: string | null,
): ImportProgress {
  return {
    jobId,
    status: advanced.status,
    campaignStatus: advanced.campaignStatus,
    totalImported: advanced.imported,
    totalDuplicates: advanced.duplicates,
    totalProtected: advanced.excluded,
    complete: advanced.sourceExhausted && advanced.status === "ready",
    error,
  };
}
