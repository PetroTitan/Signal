import "server-only";
/**
 * Building a campaign queue, resumably.
 *
 * One invocation does a BOUNDED amount of work and commits it. The next
 * invocation continues from where the database says the last one
 * stopped — not from where the browser claims it stopped, and not from
 * the beginning.
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * The candidate import walked pages with OFFSET, stopped after 20 pages
 * of 500, and returned a `nextPage` for the caller to hand back. The UI
 * never did. So every invocation started at page 1 and a corpus larger
 * than ~10,000 could never finish: the same first 10,000 rows imported
 * over and over while the remainder was never reached.
 *
 * Two separate problems, both fixed here:
 *
 *   • progress was not persisted, so it depended on the client;
 *   • OFFSET is not a safe way to walk a table that is being written
 *     to. It is O(offset) per page, and a row inserted mid-walk shifts
 *     every later page, so rows are skipped and re-read at random.
 *
 * Now: a finite snapshot and a keyset checkpoint on a job row, in the
 * total order `(first_discovered_at asc, subject_did asc)`. That
 * timestamp does not change on rediscovery; the DID is the unique
 * tie-breaker.
 *
 * DEDUPLICATION REMAINS THE DATABASE'S JOB
 * ----------------------------------------
 * `unique (campaign_id, subject_did)` is the final boundary. Retries,
 * refreshes and two concurrent imports all converge on it. Nothing here
 * holds a Set: an in-memory guard only dedupes within one call, and an
 * import is many calls.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IMPORT_CHUNK_SIZE,
  importMemberChunk,
  type ImportMemberInput,
} from "@/repositories/bluesky-campaign-repository";
import {
  advanceImportJob,
  beginImportJob,
  getImportJob,
  listCandidatesKeyset,
  type ImportJob,
  type ImportSourceKind,
} from "@/repositories/bluesky-campaign-import-repository";
import { getFollowers } from "@/core/bluesky-relationships/atproto-graph";
import { getTargetProfile } from "@/repositories/bluesky-relationship-repository";

/**
 * How many windows one invocation walks.
 *
 * Bounded so a single request cannot outlive the platform's function
 * limit. Finishing a large source takes several invocations, and each
 * one is a complete, committed unit of work — which is the property
 * that makes the whole thing resumable.
 */
export const DEFAULT_MAX_WINDOWS = 20;

export interface ResumableImportResult {
  jobId: string | null;
  status: "running" | "ready" | "failed";
  /**
   * What THIS invocation did.
   *
   * Deliberately not the running total: a caller that re-invokes after
   * completion did no work, and reporting the campaign's lifetime
   * figure here would read as "it imported 400 more".
   */
  imported: number;
  duplicates: number;
  excluded: number;
  /** The campaign's lifetime totals, for progress display. */
  totalImported: number;
  totalDuplicates: number;
  totalExcluded: number;
  /** True only when the source said it had nothing more to give. */
  complete: boolean;
  windowsRead: number;
  error: string | null;
  refusedReason: string | null;
}

const empty = (): ResumableImportResult => ({
  jobId: null,
  status: "running",
  imported: 0,
  duplicates: 0,
  excluded: 0,
  totalImported: 0,
  totalDuplicates: 0,
  totalExcluded: 0,
  complete: false,
  windowsRead: 0,
  error: null,
  refusedReason: null,
});

/**
 * Continue (or start) a campaign's import.
 *
 * Safe to call again at any time, from any number of callers. The
 * checkpoint only moves forward and the unique index catches the rest.
 */
export async function resumeCampaignImport(input: {
  workspaceId: string;
  operatorAccountId: string;
  campaignId: string;
  sourceKind: ImportSourceKind;
  targetProfileId: string | null;
  maxWindows?: number;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<ResumableImportResult> {
  const out = empty();

  let job = await beginImportJob({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    sourceKind: input.sourceKind,
    targetProfileId: input.targetProfileId,
    db: input.db,
  });

  out.jobId = job.jobId || null;
  if (job.refusedReason) {
    out.refusedReason = job.refusedReason;
    out.error =
      job.refusedReason === "source_mismatch"
        ? "This campaign is already being built from a different list. Start a new campaign to use another source."
        : "That campaign is not in this workspace.";
    out.status = "failed";
    return out;
  }

  // begin_bluesky_campaign_import predates the snapshot column. Read
  // the persisted row back so the repaired candidate walk receives the
  // database-captured boundary, never a browser or application clock.
  if (job.sourceKind === "candidates") {
    const persisted = await getImportJob({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      db: input.db,
    });
    if (!persisted?.snapshotAt) {
      out.status = "failed";
      out.error = "This campaign import needs the latest database migration.";
      return out;
    }
    job = persisted;
  }

  out.totalImported = job.importedCount;
  out.totalDuplicates = job.duplicateCount;
  out.totalExcluded = job.excludedCount;

  if (job.sourceExhausted) {
    // Already finished. Saying so is cheaper than proving it again, and
    // this invocation imported nothing.
    out.status = "ready";
    out.complete = true;
    return out;
  }

  return job.sourceKind === "target_followers"
    ? await walkTargetFollowers(input, job, out)
    : await walkCandidates(input, job, out);
}

async function walkCandidates(
  input: Parameters<typeof resumeCampaignImport>[0],
  job: ImportJob,
  out: ResumableImportResult,
): Promise<ResumableImportResult> {
  const maxWindows = Math.max(1, Math.min(input.maxWindows ?? DEFAULT_MAX_WINDOWS, 200));
  let afterAt = job.cursorLastDiscoveredAt;
  let afterDid = job.cursorSubjectDid;

  for (let window = 0; window < maxWindows; window += 1) {
    const rows = await listCandidatesKeyset({
      workspaceId: input.workspaceId,
      operatorAccountId: input.operatorAccountId,
      targetProfileId: input.targetProfileId,
      snapshotAt: job.snapshotAt!,
      afterLastDiscoveredAt: afterAt,
      afterSubjectDid: afterDid,
      limit: IMPORT_CHUNK_SIZE,
      db: input.db,
    });
    out.windowsRead += 1;

    if (rows.length === 0) {
      // The source is genuinely finished: a keyset read returns nothing
      // only at the end of the order, unlike a provider page that can
      // be short in the middle.
      await advanceImportJob({
        workspaceId: input.workspaceId,
        jobId: job.jobId,
        cursorLastDiscoveredAt: afterAt,
        cursorSubjectDid: afterDid,
        providerCursor: null,
        inserted: 0,
        duplicates: 0,
        excluded: 0,
        pages: 1,
        sourceExhausted: true,
        error: null,
        db: input.db,
      });
      out.status = "ready";
      out.complete = true;
      return out;
    }

    // Protected candidates never enter a campaign queue at all.
    const eligible = rows.filter((r) => !r.protected);
    const excluded = rows.length - eligible.length;

    let inserted = 0;
    let duplicates = 0;
    if (eligible.length > 0) {
      const members: ImportMemberInput[] = eligible.map((r) => ({
        subjectDid: r.subject_did,
        currentHandle: r.handle,
        displayName: r.display_name,
        targetProfileId: input.targetProfileId ?? undefined,
        sourceLabel:
          input.sourceKind === "target_followers" ? "target_followers" : "candidates",
      }));
      const result = await importMemberChunk({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        members,
        db: input.db,
      });
      inserted = result.inserted;
      duplicates = result.duplicates;
    }

    // The checkpoint is the LAST row of the window, in the same total
    // order the read used. If the process dies before the checkpoint,
    // the unique member key makes re-reading this window harmless.
    const last = rows[rows.length - 1];
    afterAt = last.first_discovered_at;
    afterDid = last.subject_did;

    const advanced = await advanceImportJob({
      workspaceId: input.workspaceId,
      jobId: job.jobId,
      cursorLastDiscoveredAt: afterAt,
      cursorSubjectDid: afterDid,
      providerCursor: null,
      inserted,
      duplicates,
      excluded,
      pages: 1,
      sourceExhausted: false,
      error: null,
      db: input.db,
    });

    out.imported += inserted;
    out.duplicates += duplicates;
    out.excluded += excluded;
    if (advanced) {
      out.totalImported = advanced.importedCount;
      out.totalDuplicates = advanced.duplicateCount;
      out.totalExcluded = advanced.excludedCount;
    }

    // Another caller got further while this one was working. Continue
    // from the shared checkpoint rather than re-walking a window that
    // is already done.
    if (advanced?.cursorLastDiscoveredAt) {
      afterAt = advanced.cursorLastDiscoveredAt;
      afterDid = advanced.cursorSubjectDid;
    }
  }

  out.status = "running";
  return out;
}

async function walkTargetFollowers(
  input: Parameters<typeof resumeCampaignImport>[0],
  job: ImportJob,
  out: ResumableImportResult,
): Promise<ResumableImportResult> {
  if (!input.targetProfileId) {
    out.status = "failed";
    out.error = "No profile was selected to import followers from.";
    return out;
  }
  const target = await getTargetProfile(
    input.workspaceId,
    input.targetProfileId,
    input.db,
  );
  if (!target) {
    out.status = "failed";
    out.error = "That profile is not in this workspace.";
    return out;
  }

  const maxWindows = Math.max(1, Math.min(input.maxWindows ?? DEFAULT_MAX_WINDOWS, 200));
  let cursor = job.providerCursor;

  for (let window = 0; window < maxWindows; window += 1) {
    const page = await getFollowers({
      // By DID: the handle may have changed since the profile was added.
      actor: target.subject_did,
      limit: 100,
      cursor,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
    });
    out.windowsRead += 1;

    if (!page.ok) {
      // The checkpoint is untouched, so a retry resumes from the last
      // cursor that actually worked.
      await advanceImportJob({
        workspaceId: input.workspaceId,
        jobId: job.jobId,
        cursorLastDiscoveredAt: null,
        cursorSubjectDid: null,
        providerCursor: cursor,
        inserted: 0,
        duplicates: 0,
        excluded: 0,
        pages: 0,
        sourceExhausted: false,
        error: page.message,
        db: input.db,
      });
      out.status = "failed";
      out.error = page.message;
      return out;
    }

    const members: ImportMemberInput[] = page.page.followers.map((f) => ({
      subjectDid: f.did,
      currentHandle: f.handle,
      displayName: f.displayName,
      targetProfileId: input.targetProfileId ?? undefined,
      sourceLabel: "target_followers",
    }));

    let inserted = 0;
    let duplicates = 0;
    if (members.length > 0) {
      const result = await importMemberChunk({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        members,
        db: input.db,
      });
      inserted = result.inserted;
      duplicates = result.duplicates;
    }

    cursor = page.page.cursor ?? null;
    // The source is complete ONLY when the provider stops returning a
    // cursor. A short page is not the end — a measured walk returned
    // pages of 5, 3 and 4 with millions still to come.
    const exhausted = !cursor;

    await advanceImportJob({
      workspaceId: input.workspaceId,
      jobId: job.jobId,
      cursorLastDiscoveredAt: null,
      cursorSubjectDid: null,
      providerCursor: cursor,
      inserted,
      duplicates,
      excluded: 0,
      pages: 1,
      sourceExhausted: exhausted,
      error: null,
      db: input.db,
    });

    out.imported += inserted;
    out.duplicates += duplicates;
    out.totalImported += inserted;
    out.totalDuplicates += duplicates;

    if (exhausted) {
      out.status = "ready";
      out.complete = true;
      return out;
    }
  }

  out.status = "running";
  return out;
}
