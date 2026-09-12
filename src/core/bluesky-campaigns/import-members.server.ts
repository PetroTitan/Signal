import "server-only";
/**
 * Building a campaign queue.
 *
 * Streams members in BOUNDED pages from the existing candidate corpus
 * or from a target profile's followers. Nothing here ever holds the
 * whole queue: a 100,000-member import is hundreds of bounded pages,
 * each one written and forgotten.
 *
 * DEDUPLICATION IS THE DATABASE'S JOB
 * -----------------------------------
 * `unique (campaign_id, subject_did)` is what makes a DID appear once.
 * An in-memory Set would only dedupe within a single call, and an
 * import of overlapping audiences is many calls — some of them
 * concurrent, if an operator runs two imports at once. The constraint
 * holds in every case a Set does not.
 *
 * A DID already in the campaign keeps its original `import_sequence`
 * and whatever progress it has made. Re-importing an overlapping
 * audience is therefore cheap and safe, and — importantly — it never
 * reshuffles the queue underneath a running campaign.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IMPORT_CHUNK_SIZE,
  importMemberChunk,
  type ImportMemberInput,
} from "@/repositories/bluesky-campaign-repository";
import { listCandidatesPage } from "@/repositories/bluesky-relationship-repository";
import { getFollowers } from "@/core/bluesky-relationships/atproto-graph";
import { getTargetProfile } from "@/repositories/bluesky-relationship-repository";

export interface ImportSummary {
  inserted: number;
  duplicates: number;
  pagesRead: number;
  /** True only when the source was fully consumed. */
  complete: boolean;
  /** Provider cursor to continue from, when not complete. */
  cursor: string | null;
  error: string | null;
}

/**
 * Import from the workspace's existing candidate corpus.
 *
 * Reuses the relationship subsystem's paginated reader rather than a
 * second query path, so the campaign queue and the Candidates tab can
 * never disagree about what exists.
 *
 * `maxPages` bounds one invocation. A 100,000-candidate corpus takes
 * several calls; each is a complete, committed unit of work.
 */
export async function importFromCandidates(input: {
  workspaceId: string;
  operatorAccountId: string;
  campaignId: string;
  /** Only these relationship states. Defaults to the followable ones. */
  states?: ("unknown" | "not_following" | "follows_you")[];
  startPage?: number;
  maxPages?: number;
  db?: SupabaseClient;
}): Promise<ImportSummary & { nextPage: number | null }> {
  const summary: ImportSummary & { nextPage: number | null } = {
    inserted: 0,
    duplicates: 0,
    pagesRead: 0,
    complete: false,
    cursor: null,
    error: null,
    nextPage: null,
  };

  const states = input.states ?? ["unknown", "not_following", "follows_you"];
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 20, 200));
  let page = Math.max(1, input.startPage ?? 1);

  for (let i = 0; i < maxPages; i += 1) {
    const candidates = await listCandidatesPage({
      workspaceId: input.workspaceId,
      operatorAccountId: input.operatorAccountId,
      states,
      page,
      pageSize: IMPORT_CHUNK_SIZE,
      db: input.db,
    });
    summary.pagesRead += 1;

    // Protected candidates are excluded at import, so a protected
    // relationship never enters a campaign queue at all.
    const members: ImportMemberInput[] = candidates.rows
      .filter((c) => !c.protected)
      .map((c) => ({
        subjectDid: c.subject_did,
        currentHandle: c.handle,
        displayName: c.display_name,
        sourceLabel: "candidates",
      }));

    if (members.length > 0) {
      const result = await importMemberChunk({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        members,
        db: input.db,
      });
      summary.inserted += result.inserted;
      summary.duplicates += result.duplicates;
    }

    if (page >= candidates.totalPages) {
      summary.complete = true;
      return summary;
    }
    page += 1;
  }

  summary.nextPage = page;
  return summary;
}

/**
 * Import a target profile's followers straight into the queue.
 *
 * Paginates with the provider's cursor, exactly as the relationship
 * import does — and with the same rule: the source is complete ONLY
 * when the provider stops returning a cursor. A short page is not the
 * end; a measured walk returned pages of 5, 3 and 4 with millions still
 * to come.
 */
export async function importFromTargetFollowers(input: {
  workspaceId: string;
  campaignId: string;
  targetProfileId: string;
  cursor?: string | null;
  maxPages?: number;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<ImportSummary> {
  const summary: ImportSummary = {
    inserted: 0,
    duplicates: 0,
    pagesRead: 0,
    complete: false,
    cursor: input.cursor ?? null,
    error: null,
  };

  const target = await getTargetProfile(
    input.workspaceId,
    input.targetProfileId,
    input.db,
  );
  if (!target) {
    summary.error = "That target profile is not in this workspace.";
    return summary;
  }

  const maxPages = Math.max(1, Math.min(input.maxPages ?? 20, 200));
  let cursor = input.cursor ?? null;

  for (let i = 0; i < maxPages; i += 1) {
    const page = await getFollowers({
      // By DID: the target's handle may have changed since it was added.
      actor: target.subject_did,
      limit: 100,
      cursor,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
    });
    if (!page.ok) {
      summary.error = page.message;
      return summary;
    }
    summary.pagesRead += 1;

    const members: ImportMemberInput[] = page.page.followers.map((f) => ({
      subjectDid: f.did,
      currentHandle: f.handle,
      displayName: f.displayName,
      targetProfileId: input.targetProfileId,
      sourceLabel: "target_followers",
    }));

    if (members.length > 0) {
      const result = await importMemberChunk({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        members,
        db: input.db,
      });
      summary.inserted += result.inserted;
      summary.duplicates += result.duplicates;
    }

    cursor = page.page.cursor;
    summary.cursor = cursor;

    // Completion is cursor exhaustion and nothing else.
    if (cursor === null) {
      summary.complete = true;
      return summary;
    }
  }

  return summary;
}
