import "server-only";
/**
 * Follower import — the orchestration that turns a target profile into
 * candidate rows.
 *
 * Reads go to the public AppView, so a large import never spends the
 * operator's PDS write budget and can therefore never starve publishing.
 *
 * Restartable / idempotent / resumable / bounded / duplicate-safe, in
 * the specific senses:
 *
 *   restartable  — a run that failed keeps its cursor, so "continue"
 *                  re-requests the page that failed instead of starting
 *                  over from the top of a 34-million-follower list;
 *   idempotent   — candidates upsert on DID, so re-importing an
 *                  audience updates metadata and touches
 *                  last_discovered_at without creating second rows or
 *                  disturbing history;
 *   resumable    — progress is persisted after EVERY page, not at the
 *                  end, so an interruption loses at most one page;
 *   bounded      — a single invocation fetches at most `pageBudget`
 *                  pages and then pauses with a valid cursor;
 *   duplicate-safe — deduplication is a database unique constraint on
 *                  (workspace, identity, DID), not an in-memory set
 *                  that only covers one run.
 *
 * And the claim it refuses to make: the run is `completed` only when
 * the provider returned a page with no cursor, which the database's
 * CHECK constraint independently enforces.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getFollowers,
  resolveProfile,
  type GraphFailure,
} from "./atproto-graph";
import {
  applyFailure,
  applyPage,
  DEFAULT_FOLLOWER_BUDGET,
  DEFAULT_PAGE_BUDGET,
  DEFAULT_PAGE_SIZE,
  type ImportRunState,
} from "./import-plan";
import {
  createImportRun,
  getLatestImportRun,
  getTargetProfile,
  recordCandidateSources,
  recordDiscoveredCandidates,
  updateImportRun,
  upsertTargetProfile,
} from "@/repositories/bluesky-relationship-repository";
import type {
  BlueskyImportRunRow,
  BlueskyTargetProfileRow,
} from "@/lib/supabase/types";

export interface AddTargetResult {
  ok: boolean;
  target: BlueskyTargetProfileRow | null;
  error: string | null;
}

/**
 * Resolve an operator-typed handle (or DID) and persist it as a target.
 *
 * The operator's exact input is stored in `requested_identifier` for the
 * audit trail, but the row is keyed by the DID the provider returned.
 * Typing an old handle for an account already tracked therefore updates
 * the existing target rather than creating a duplicate.
 */
export async function addTargetProfile(input: {
  workspaceId: string;
  operatorAccountId: string;
  identifier: string;
  createdBy: string | null;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<AddTargetResult> {
  const identifier = input.identifier.trim().replace(/^@/, "");
  if (identifier.length === 0) {
    return { ok: false, target: null, error: "Enter a Bluesky handle or DID." };
  }

  const resolved = await resolveProfile({
    actor: identifier,
    appView: input.appView,
    fetchImpl: input.fetchImpl,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      target: null,
      error:
        resolved.kind === "not_found"
          ? `Bluesky has no account for "${identifier}".`
          : resolved.message,
    };
  }

  const target = await upsertTargetProfile({
    workspaceId: input.workspaceId,
    operatorAccountId: input.operatorAccountId,
    subjectDid: resolved.profile.did,
    handle: resolved.profile.handle,
    displayName: resolved.profile.displayName,
    avatarUrl: resolved.profile.avatarUrl,
    followersCount: resolved.profile.followersCount,
    requestedIdentifier: identifier,
    createdBy: input.createdBy,
    db: input.db,
  });

  return { ok: true, target, error: null };
}

export interface ImportResult {
  ok: boolean;
  run: BlueskyImportRunRow | null;
  /** True only when the provider's cursor is exhausted. */
  complete: boolean;
  pagesFetched: number;
  followersSeen: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  stopReason: string | null;
  error: string | null;
}

/**
 * Import (or continue importing) a target's followers.
 *
 * Resumes the most recent run when that run is resumable — paused or
 * failed with a cursor — and otherwise starts a fresh one. A COMPLETED
 * run is not resumed: continuing past exhaustion would re-walk the list
 * from the top, which is a legitimate thing to want but is a separate,
 * explicit "refresh" rather than a silent side effect of "continue".
 */
export async function importFollowers(input: {
  workspaceId: string;
  operatorAccountId: string;
  targetProfileId: string;
  startedBy: string | null;
  pageBudget?: number;
  /** Maximum followers to read in this invocation. Capped at 10,000. */
  followerBudget?: number;
  pageSize?: number;
  /** Force a new pass even if a completed run exists. */
  restart?: boolean;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<ImportResult> {
  const empty: ImportResult = {
    ok: false,
    run: null,
    complete: false,
    pagesFetched: 0,
    followersSeen: 0,
    candidatesCreated: 0,
    candidatesUpdated: 0,
    stopReason: null,
    error: null,
  };

  const target = await getTargetProfile(
    input.workspaceId,
    input.targetProfileId,
    input.db,
  );
  if (!target) {
    return { ...empty, error: "That target profile is not in this workspace." };
  }
  // Belt-and-braces: the target row is workspace-scoped by the query
  // above, and this asserts it also belongs to the identity the caller
  // authorised for.
  if (target.operator_account_id !== input.operatorAccountId) {
    return {
      ...empty,
      error: "That target profile belongs to a different identity.",
    };
  }

  const previous = await getLatestImportRun(
    input.workspaceId,
    input.targetProfileId,
    input.db,
  );
  const resumable =
    previous !== null &&
    !input.restart &&
    (previous.status === "paused" ||
      previous.status === "failed" ||
      previous.status === "running" ||
      previous.status === "pending");

  let run = resumable
    ? previous
    : await createImportRun({
        workspaceId: input.workspaceId,
        targetProfileId: input.targetProfileId,
        startedBy: input.startedBy,
        db: input.db,
      });

  // A run that already reached completion is reported as-is. Nothing is
  // re-fetched and nothing is re-claimed.
  if (run.status === "completed" && run.cursor_exhausted && !input.restart) {
    return {
      ok: true,
      run,
      complete: true,
      pagesFetched: run.pages_fetched,
      followersSeen: run.followers_seen,
      candidatesCreated: run.candidates_created,
      candidatesUpdated: run.candidates_updated,
      stopReason: null,
      error: null,
    };
  }

  const budget = Math.max(1, Math.min(input.pageBudget ?? DEFAULT_PAGE_BUDGET, DEFAULT_PAGE_BUDGET));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE));
  const followerBudget = Math.max(
    1,
    Math.min(input.followerBudget ?? DEFAULT_FOLLOWER_BUDGET, DEFAULT_FOLLOWER_BUDGET),
  );

  // Counters start from the run's persisted values so a resumed import
  // reports cumulative totals rather than this invocation's slice.
  let state: ImportRunState = {
    status: "running",
    cursor: run.cursor,
    cursorExhausted: run.cursor_exhausted,
    pagesFetched: run.pages_fetched,
    followersSeen: run.followers_seen,
  };
  let created = run.candidates_created;
  let updated = run.candidates_updated;
  // The page budget applies to THIS invocation, so a run resumed for the
  // fifth time is not immediately over budget.
  const budgetCeiling = state.pagesFetched + budget;
  // A click means "up to 10,000 MORE", even when it resumes a run that
  // already imported earlier slices. The provider cursor remains the
  // source of truth; the count is only the bounded yield point.
  const followerCeiling = state.followersSeen + followerBudget;
  let lastError: string | null = null;
  let stopReason: string | null = null;
  let complete = false;

  const startedAt = run.started_at ?? new Date().toISOString();

  for (;;) {
    // Do not overshoot the requested follower count on the final page.
    // Bluesky accepts a smaller `limit`, and completion still depends
    // solely on cursor exhaustion rather than on the returned length.
    const remainingThisInvocation = followerCeiling - state.followersSeen;
    const page = await getFollowers({
      // Query by DID. The target's handle may have changed since it was
      // added, and the DID cannot.
      actor: target.subject_did,
      limit: Math.min(pageSize, remainingThisInvocation),
      cursor: state.cursor,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
    });

    if (!page.ok) {
      const progress = applyFailure({ state, failure: page as GraphFailure });
      run = await updateImportRun({
        workspaceId: input.workspaceId,
        runId: run.id,
        status: progress.status,
        cursor: progress.cursor,
        cursorExhausted: progress.cursorExhausted,
        pagesFetched: progress.pagesFetched,
        followersSeen: progress.followersSeen,
        candidatesCreated: created,
        candidatesUpdated: updated,
        stopReason: progress.stopReason,
        lastError: progress.lastError,
        startedAt,
        finishedAt: new Date().toISOString(),
        db: input.db,
      });
      return {
        ok: false,
        run,
        complete: false,
        pagesFetched: progress.pagesFetched,
        followersSeen: progress.followersSeen,
        candidatesCreated: created,
        candidatesUpdated: updated,
        stopReason: progress.stopReason,
        error: progress.lastError,
      };
    }

    // Persist this page's discoveries BEFORE advancing the cursor, so an
    // interruption between the two re-fetches a page we already stored
    // (harmless, because the upsert is idempotent) rather than skipping
    // a page we never stored.
    const discovered = await recordDiscoveredCandidates({
      workspaceId: input.workspaceId,
      operatorAccountId: input.operatorAccountId,
      followers: page.page.followers.map((f) => ({
        did: f.did,
        handle: f.handle,
        displayName: f.displayName,
        avatarUrl: f.avatarUrl,
      })),
      db: input.db,
    });
    created += discovered.created;
    updated += discovered.updated;

    if (discovered.idsByDid.size > 0) {
      await recordCandidateSources({
        workspaceId: input.workspaceId,
        targetProfileId: input.targetProfileId,
        candidateIds: [...discovered.idsByDid.values()],
        db: input.db,
      });
    }

    const progress = applyPage({
      state,
      page: page.page,
      newFollowerCount: page.page.followers.length,
      // Translate the per-invocation budget into the absolute page count
      // applyPage compares against.
      pageBudget: budgetCeiling,
      followerCeiling,
      rateLimitRemaining: page.rateLimit?.remaining ?? null,
    });

    complete = progress.cursorExhausted;
    stopReason = progress.stopReason;
    lastError = progress.lastError;

    run = await updateImportRun({
      workspaceId: input.workspaceId,
      runId: run.id,
      status: progress.status,
      cursor: progress.cursor,
      cursorExhausted: progress.cursorExhausted,
      pagesFetched: progress.pagesFetched,
      followersSeen: progress.followersSeen,
      candidatesCreated: created,
      candidatesUpdated: updated,
      stopReason: progress.stopReason,
      lastError: progress.lastError,
      startedAt,
      finishedAt: progress.continueNow ? null : new Date().toISOString(),
      db: input.db,
    });

    state = {
      status: progress.status,
      cursor: progress.cursor,
      cursorExhausted: progress.cursorExhausted,
      pagesFetched: progress.pagesFetched,
      followersSeen: progress.followersSeen,
    };

    if (!progress.continueNow) break;
  }

  return {
    ok: true,
    run,
    complete,
    pagesFetched: state.pagesFetched,
    followersSeen: state.followersSeen,
    candidatesCreated: created,
    candidatesUpdated: updated,
    stopReason,
    error: lastError,
  };
}
