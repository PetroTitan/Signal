import "server-only";
/**
 * One loader for the whole Bluesky Relationships surface.
 *
 * Every view reads from this single projection, so the counts in the
 * tab strip cannot disagree with the rows inside the tabs.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The first version read 500 candidates and derived every total from
 * that array. Past 500 it under-reported silently — "500 candidates"
 * and "the first 500 of them" were indistinguishable — and rows 501+
 * were unreachable. Totals now come from `count: "exact"` queries that
 * transfer no rows, and the list is a real page.
 *
 * The view is driven entirely by URL parameters rather than client
 * state, so a filtered page is shareable, the browser's Back button
 * works, and the page a request renders is a pure function of its URL.
 *
 * The projection is DID-keyed throughout. Handles appear only as
 * display text, and `subjectHandleAtAction` in history is deliberately
 * the handle observed AT THE TIME — a rename must not rewrite what the
 * operator saw when they acted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import {
  CANDIDATE_PAGE_SIZE,
  countActionsNeedingReconciliation,
  countCandidatesByState,
  getLatestImportRun,
  HISTORY_PAGE_SIZE,
  listActionHistoryPage,
  listBatches,
  listCandidatesPage,
  listTargetProfiles,
  type CandidateStateCounts,
  type CandidateWithSources,
} from "@/repositories/bluesky-relationship-repository";
import type {
  BlueskyActionBatchRow,
  BlueskyImportRunRow,
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
  BlueskyTargetProfileRow,
} from "@/lib/supabase/types";
import { describeImportProgress } from "./import-plan";
import { classifyReadFailure, type ReadFailure } from "./read-failure";

import {
  RELATIONSHIP_STATES,
  RELATIONSHIP_TABS,
  type PageInfo,
  type RelationshipsQuery,
  type RelationshipTab,
} from "./load-relationships.server.types";

export {
  RELATIONSHIP_STATES,
  RELATIONSHIP_TABS,
  type PageInfo,
  type RelationshipsQuery,
  type RelationshipTab,
};

export function parseTab(raw: string | undefined): RelationshipTab {
  return (RELATIONSHIP_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as RelationshipTab)
    : "targets";
}

/** Which relationship states a tab lists. undefined means "no filter". */
export function statesForTab(
  tab: RelationshipTab,
  explicit: BlueskyRelationshipState | null,
): BlueskyRelationshipState[] | undefined {
  if (tab === "following") return ["following", "mutual"];
  if (tab === "mutual") return ["mutual"];
  if (tab === "candidates" && explicit) return [explicit];
  return undefined;
}

export function parseState(
  raw: string | undefined,
): BlueskyRelationshipState | null {
  return RELATIONSHIP_STATES.includes(raw as BlueskyRelationshipState)
    ? (raw as BlueskyRelationshipState)
    : null;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export interface TargetWithImport {
  target: BlueskyTargetProfileRow;
  run: BlueskyImportRunRow | null;
  /** Operator-facing progress line. Only claims completeness when true. */
  progressLabel: string;
  /** True only when the provider's cursor is exhausted. */
  complete: boolean;
}

export interface RelationshipsView {
  identities: { id: string; handle: string | null; displayName: string | null }[];
  selectedIdentityId: string | null;
  selectedIdentityHandle: string | null;
  connected: boolean;
  query: RelationshipsQuery;
  targets: TargetWithImport[];
  candidates: CandidateWithSources[];
  candidatePage: PageInfo;
  history: BlueskyRelationshipActionRow[];
  historyPage: PageInfo;
  batches: BlueskyActionBatchRow[];
  /** Exact counts from Postgres, narrowed by the active search. */
  counts: CandidateStateCounts & { needsReconciliation: number };
  /** Handle by target id, for rendering source attribution chips. */
  targetLabels: Map<string, string>;
  /**
   * Set when the relationship reads failed.
   *
   * The page renders this INSTEAD of a list, never alongside an empty
   * one — "no candidates yet" over a failed read reads as success and
   * is the single worst thing this surface could say.
   */
  failure: ReadFailure | null;
}

const emptyPage = (pageSize: number): PageInfo => ({
  page: 1,
  pageSize,
  total: 0,
  totalPages: 1,
});

export async function loadRelationships(input: {
  workspaceId: string;
  operatorAccountId: string | null;
  searchParams?: {
    tab?: string;
    q?: string;
    state?: string;
    page?: string;
    hpage?: string;
  };
  db?: SupabaseClient;
}): Promise<RelationshipsView> {
  const sp = input.searchParams ?? {};
  const query: RelationshipsQuery = {
    tab: parseTab(sp.tab),
    search: (sp.q ?? "").trim().slice(0, 100),
    state: parseState(sp.state),
    page: parsePage(sp.page),
    historyPage: parsePage(sp.hpage),
  };

  const accounts = await listAccountsByPlatform(input.workspaceId, "bluesky");
  const identities = accounts.map((a) => ({
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
  }));

  const selected =
    (input.operatorAccountId &&
      identities.find((i) => i.id === input.operatorAccountId)) ||
    identities[0] ||
    null;

  const base: RelationshipsView = {
    identities,
    selectedIdentityId: selected?.id ?? null,
    selectedIdentityHandle: selected?.handle ?? null,
    connected: false,
    query,
    targets: [],
    candidates: [],
    candidatePage: emptyPage(CANDIDATE_PAGE_SIZE),
    history: [],
    historyPage: emptyPage(HISTORY_PAGE_SIZE),
    batches: [],
    counts: {
      total: 0,
      unknown: 0,
      not_following: 0,
      following: 0,
      follows_you: 0,
      mutual: 0,
      protectedCount: 0,
      needsReconciliation: 0,
    },
    targetLabels: new Map(),
    failure: null,
  };
  // No Bluesky identity: return before touching any relationship table.
  // This is also what keeps the page rendering its empty state rather
  // than erroring when the schema has not been provisioned yet.
  if (!selected) return base;

  const account = accounts.find((a) => a.id === selected.id);
  const connected = account?.connectionStatus === "connected";

  const listsStates = statesForTab(query.tab, query.state);

  // Every relationship read in one place, so a failure is classified
  // once and the page renders one honest surface rather than five
  // half-loaded sections.
  let reads;
  try {
    reads = await Promise.all([
      listTargetProfiles(input.workspaceId, selected.id, input.db),
      listCandidatesPage({
        workspaceId: input.workspaceId,
        operatorAccountId: selected.id,
        states: listsStates,
        search: query.search || undefined,
        page: query.page,
        db: input.db,
      }),
      countCandidatesByState({
        workspaceId: input.workspaceId,
        operatorAccountId: selected.id,
        search: query.search || undefined,
        db: input.db,
      }),
      listActionHistoryPage({
        workspaceId: input.workspaceId,
        operatorAccountId: selected.id,
        page: query.historyPage,
        db: input.db,
      }),
      listBatches(input.workspaceId, selected.id, 15, input.db),
      countActionsNeedingReconciliation({
        workspaceId: input.workspaceId,
        operatorAccountId: selected.id,
        db: input.db,
      }),
    ]);
  } catch (err) {
    // Classified, not swallowed. A missing table or a refused read is
    // reported as itself; only a genuine transport blip offers a retry.
    return { ...base, connected, failure: classifyReadFailure(err) };
  }

  const [targetRows, candidatePage, counts, historyPage, batches, needsReconciliation] =
    reads;

  const targets: TargetWithImport[] = [];
  for (const target of targetRows) {
    // Per-target import progress is secondary. If one read fails the
    // target still lists, with its progress honestly unknown, rather
    // than taking the whole page down.
    let run: BlueskyImportRunRow | null = null;
    try {
      run = await getLatestImportRun(input.workspaceId, target.id, input.db);
    } catch {
      run = null;
    }
    targets.push({
      target,
      run,
      progressLabel: run
        ? describeImportProgress({
            status: run.status,
            cursorExhausted: run.cursor_exhausted,
            followersSeen: run.followers_seen,
            stopReason: run.stop_reason,
          })
        : "Not started.",
      // Both conditions, not just the status: the completeness claim is
      // only as good as the cursor evidence behind it.
      complete: run?.status === "completed" && run.cursor_exhausted,
    });
  }

  return {
    ...base,
    connected,
    targets,
    candidates: candidatePage.rows,
    candidatePage: {
      page: candidatePage.page,
      pageSize: candidatePage.pageSize,
      total: candidatePage.total,
      totalPages: candidatePage.totalPages,
    },
    history: historyPage.rows,
    historyPage: {
      page: historyPage.page,
      pageSize: historyPage.pageSize,
      total: historyPage.total,
      totalPages: historyPage.totalPages,
    },
    batches,
    counts: {
      ...counts,
      // Counted across the whole history, not the visible page: it is a
      // standing condition the operator must not be able to page past.
      needsReconciliation,
    },
    targetLabels: new Map(
      targetRows.map((t) => [t.id, t.handle ?? t.subject_did]),
    ),
  };
}
