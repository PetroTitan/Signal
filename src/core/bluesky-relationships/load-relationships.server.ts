import "server-only";
/**
 * One loader for the whole Bluesky Relationships surface.
 *
 * Every view on the page (Targets, Candidates, Following, Mutual,
 * History) reads from this single projection, so the counts in the tab
 * strip cannot disagree with the rows inside the tabs.
 *
 * The projection is DID-keyed throughout. Handles appear only as
 * display text, and `subjectHandleAtAction` in history is deliberately
 * the handle observed AT THE TIME rather than the current one — a
 * rename must not rewrite what the operator saw when they acted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import {
  getLatestImportRun,
  listBatches,
  listActionHistory,
  listCandidates,
  listTargetProfiles,
  type CandidateWithSources,
} from "@/repositories/bluesky-relationship-repository";
import type {
  BlueskyActionBatchRow,
  BlueskyImportRunRow,
  BlueskyRelationshipActionRow,
  BlueskyTargetProfileRow,
} from "@/lib/supabase/types";
import { describeImportProgress } from "./import-plan";

export interface TargetWithImport {
  target: BlueskyTargetProfileRow;
  run: BlueskyImportRunRow | null;
  /** Operator-facing progress line. Only claims completeness when true. */
  progressLabel: string;
  /** True only when the provider's cursor is exhausted. */
  complete: boolean;
}

export interface RelationshipsView {
  /** Bluesky identities in this workspace, for the identity picker. */
  identities: { id: string; handle: string | null; displayName: string | null }[];
  selectedIdentityId: string | null;
  selectedIdentityHandle: string | null;
  /** Whether the selected identity has a usable Bluesky session. */
  connected: boolean;
  targets: TargetWithImport[];
  candidates: CandidateWithSources[];
  history: BlueskyRelationshipActionRow[];
  batches: BlueskyActionBatchRow[];
  counts: {
    candidates: number;
    following: number;
    mutual: number;
    followsYou: number;
    unknown: number;
    protectedCount: number;
    needsReconciliation: number;
  };
  /** Handle by target id, for rendering source attribution chips. */
  targetLabels: Map<string, string>;
}

export async function loadRelationships(input: {
  workspaceId: string;
  /** Null selects the first Bluesky identity, if any. */
  operatorAccountId: string | null;
  db?: SupabaseClient;
}): Promise<RelationshipsView> {
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

  const empty: RelationshipsView = {
    identities,
    selectedIdentityId: selected?.id ?? null,
    selectedIdentityHandle: selected?.handle ?? null,
    connected: false,
    targets: [],
    candidates: [],
    history: [],
    batches: [],
    counts: {
      candidates: 0,
      following: 0,
      mutual: 0,
      followsYou: 0,
      unknown: 0,
      protectedCount: 0,
      needsReconciliation: 0,
    },
    targetLabels: new Map(),
  };
  if (!selected) return empty;

  const account = accounts.find((a) => a.id === selected.id);
  const connected = account?.connectionStatus === "connected";

  const [targetRows, candidates, history, batches] = await Promise.all([
    listTargetProfiles(input.workspaceId, selected.id, input.db),
    listCandidates({
      workspaceId: input.workspaceId,
      operatorAccountId: selected.id,
      limit: 500,
      db: input.db,
    }),
    listActionHistory({
      workspaceId: input.workspaceId,
      operatorAccountId: selected.id,
      limit: 100,
      db: input.db,
    }),
    listBatches(input.workspaceId, selected.id, 15, input.db),
  ]);

  const targets: TargetWithImport[] = [];
  for (const target of targetRows) {
    const run = await getLatestImportRun(input.workspaceId, target.id, input.db);
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

  const counts = {
    candidates: candidates.length,
    following: candidates.filter((c) => c.relationship_state === "following").length,
    mutual: candidates.filter((c) => c.relationship_state === "mutual").length,
    followsYou: candidates.filter((c) => c.relationship_state === "follows_you").length,
    unknown: candidates.filter((c) => c.relationship_state === "unknown").length,
    protectedCount: candidates.filter((c) => c.protected).length,
    needsReconciliation: history.filter(
      (h) => h.status === "reconciliation_required",
    ).length,
  };

  return {
    identities,
    selectedIdentityId: selected.id,
    selectedIdentityHandle: selected.handle,
    connected,
    targets,
    candidates,
    history,
    batches,
    counts,
    targetLabels: new Map(
      targetRows.map((t) => [t.id, t.handle ?? t.subject_did]),
    ),
  };
}
