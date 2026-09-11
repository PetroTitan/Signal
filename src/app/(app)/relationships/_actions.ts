"use server";
/**
 * Server actions for Bluesky relationship management.
 *
 * THE AUTHORIZATION BOUNDARY IS HERE.
 *
 * Every export begins with `requireRelationshipContext`, which
 * establishes four things in order and refuses at the first failure:
 *
 *   1. an authenticated user           (supabase.auth.getUser)
 *   2. a workspace membership          (getPrimaryWorkspace)
 *   3. a permission for the operation  (can(role, …))
 *   4. that the identity being acted   (getAccountById scoped by the
 *      through belongs to THAT          workspace id from step 2)
 *      workspace
 *
 * Step 4 matters as much as the rest: an account id is a bare uuid in a
 * form field, so a caller can supply one belonging to another
 * workspace. Loading it through a workspace-scoped query is what makes
 * that fail. RLS is a second line, not the first, because some of the
 * work below can run with an injected client.
 *
 * PERMISSIONS
 * -----------
 * Mutations require `connect_platforms`, the same permission that gates
 * connecting an account, because a follow acts AS the operator's
 * account in public. Note that `editor` and `reviewer` do not have it,
 * while `reviewer` does have `approve_content` — the role model is a
 * matrix, not a ladder, so every check below asks `can(role,
 * permission)` and none compares roles.
 *
 * Reads require `view_content`.
 *
 * WHAT NO ACTION HERE DOES
 * ------------------------
 * There is no action that schedules relationship work, none that sets a
 * daily quota, none that unfollows based on whether someone followed
 * back, and none that runs without an operator request. `confirmAndRun`
 * is the only entry point to a batch, it is called from a form the
 * operator submits, and it processes exactly the rows that existed when
 * they confirmed.
 */

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { can, type Permission } from "@/core/teams/permissions";
import { formatHandle } from "@/core/bluesky-relationships/handle-display";
import { checkBatchSize } from "@/core/bluesky-relationships/limits";
import type { WorkspaceRole } from "@/lib/supabase/types";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import {
  addTargetProfile,
  importFollowers,
} from "@/core/bluesky-relationships/import-followers.server";
import { refreshRelationships } from "@/core/bluesky-relationships/refresh-relationships.server";
import {
  processBatchActions,
  type RelationshipStateByDid,
} from "@/core/bluesky-relationships/execute-actions.server";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  BatchMembershipFrozenError,
  confirmBatch,
  createAction,
  createBatch,
  deleteTargetProfile,
  DuplicateActiveActionError,
  getCandidateSourceIds,
  getCandidatesByIds,
  listBatchActions,
  setCandidateProtected,
  updateBatchProgress,
} from "@/repositories/bluesky-relationship-repository";
import type { BlueskyActionType } from "@/lib/supabase/types";

const RELATIONSHIPS_PATH = "/relationships";

// =====================================================================
// Authorization
// =====================================================================

interface RelationshipContext {
  kind: "ok";
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  operatorAccountId: string;
  operatorHandle: string | null;
}

type ContextResult =
  | RelationshipContext
  | { kind: "error"; message: string };

async function requireRelationshipContext(
  operatorAccountId: string,
  permission: Permission,
): Promise<ContextResult> {
  if (!operatorAccountId) {
    return { kind: "error", message: "Pick a Bluesky identity first." };
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "error", message: "Sign in first." };

  const membership = await getPrimaryWorkspace();
  if (!membership) return { kind: "error", message: "No workspace found." };

  if (!can(membership.role, permission)) {
    return {
      kind: "error",
      message:
        permission === "connect_platforms"
          ? "Your role cannot change Bluesky relationships. Ask an owner or admin."
          : "Your role cannot view this.",
    };
  }

  // The identity must belong to THIS workspace. A bare uuid from a form
  // is not evidence of anything until it survives this query.
  let identity;
  try {
    identity = await getAccountById(membership.workspace.id, operatorAccountId);
  } catch {
    return {
      kind: "error",
      message: "That identity is not in your workspace.",
    };
  }
  if (identity.platform !== "bluesky") {
    return {
      kind: "error",
      message: "Relationship actions are Bluesky-only.",
    };
  }

  return {
    kind: "ok",
    workspaceId: membership.workspace.id,
    userId: user.id,
    role: membership.role,
    operatorAccountId,
    operatorHandle: identity.handle,
  };
}

// =====================================================================
// Targets
// =====================================================================

export type AddTargetActionResult = ActionResult<{ targetId: string }>;

export async function addTargetAction(
  _prev: AddTargetActionResult,
  formData: FormData,
): Promise<AddTargetActionResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const identifier = String(formData.get("identifier") ?? "").trim();

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  if (!identifier) return actionFail("Enter a Bluesky handle.");

  try {
    const result = await addTargetProfile({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      identifier,
      createdBy: ctx.userId,
    });
    if (!result.ok || !result.target) {
      return actionFail(result.error ?? "Could not add that profile.");
    }
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "bluesky_relationships.target_added",
      entityType: "bluesky_target_profile",
      entityId: result.target.id,
      title: `Bluesky target added: ${formatHandle(
        result.target.handle,
        result.target.subject_did,
      )}`,
      description: `Resolved "${identifier}" to ${result.target.subject_did}.`,
    }).catch(() => undefined);

    revalidatePath(RELATIONSHIPS_PATH);
    return actionOk({ targetId: result.target.id });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not add that profile.",
    );
  }
}

export type ImportActionResult = ActionResult<{
  complete: boolean;
  followersSeen: number;
  summary: string;
}>;

/**
 * Import or continue importing a target's followers.
 *
 * Bounded per invocation. "Complete" in the result is the run's
 * `cursor_exhausted`, not a guess from how many rows came back.
 */
export async function importFollowersAction(
  _prev: ImportActionResult,
  formData: FormData,
): Promise<ImportActionResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const targetProfileId = String(formData.get("target_profile_id") ?? "");
  const restart = String(formData.get("restart") ?? "") === "1";

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  if (!targetProfileId) return actionFail("Pick a target profile.");

  try {
    const result = await importFollowers({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      targetProfileId,
      startedBy: ctx.userId,
      restart,
    });

    revalidatePath(RELATIONSHIPS_PATH);

    if (!result.ok) {
      return actionFail(
        result.error ??
          "The import stopped. Progress is saved — continue to pick up where it left off.",
      );
    }
    const summary = result.complete
      ? `Imported ${result.followersSeen.toLocaleString()} followers (complete).`
      : `${result.followersSeen.toLocaleString()} followers so far. More remain — continue when ready.`;
    return actionOk({
      complete: result.complete,
      followersSeen: result.followersSeen,
      summary,
    });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "The import could not run.",
    );
  }
}

export type RemoveTargetActionResult = ActionResult<{ removed: true }>;

export async function removeTargetAction(
  _prev: RemoveTargetActionResult,
  formData: FormData,
): Promise<RemoveTargetActionResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const targetProfileId = String(formData.get("target_profile_id") ?? "");

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  try {
    await deleteTargetProfile(ctx.workspaceId, targetProfileId);
    revalidatePath(RELATIONSHIPS_PATH);
    return actionOk({ removed: true as const });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not remove that target.",
    );
  }
}

// =====================================================================
// Protection
// =====================================================================

export type ProtectActionResult = ActionResult<{ protectedValue: boolean }>;

export async function setProtectedAction(
  _prev: ProtectActionResult,
  formData: FormData,
): Promise<ProtectActionResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const candidateId = String(formData.get("candidate_id") ?? "");
  const protectedValue = String(formData.get("protected") ?? "") === "1";

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  if (!candidateId) return actionFail("Pick an account.");

  try {
    await setCandidateProtected({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      candidateId,
      protectedValue,
      actorUserId: ctx.userId,
    });
    revalidatePath(RELATIONSHIPS_PATH);
    return actionOk({ protectedValue });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not change protection.",
    );
  }
}

// =====================================================================
// Relationship refresh
// =====================================================================

export type RefreshActionResult = ActionResult<{ checked: number; unknown: number }>;

export async function refreshRelationshipsAction(
  _prev: RefreshActionResult,
  formData: FormData,
): Promise<RefreshActionResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const candidateIds = formData.getAll("candidate_id").map(String).filter(Boolean);

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);
  if (candidateIds.length === 0) return actionFail("Select at least one account.");

  const session = await resolveRelationshipSession({
    workspaceId: ctx.workspaceId,
    accountId: ctx.operatorAccountId,
  });
  if (!session.ok) return actionFail(session.message);

  try {
    const candidates = await getCandidatesByIds(
      ctx.workspaceId,
      ctx.operatorAccountId,
      candidateIds,
    );
    const result = await refreshRelationships({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      actorDid: session.actorDid,
      subjectDids: candidates.map((c) => c.subject_did),
    });
    revalidatePath(RELATIONSHIPS_PATH);
    if (result.error) {
      return actionFail(
        `${result.error} ${result.unknown} account(s) are recorded as unknown rather than assumed unfollowed.`,
      );
    }
    return actionOk({ checked: result.checked, unknown: result.unknown });
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "Could not read relationships.",
    );
  }
}

// =====================================================================
// Follow / Unfollow
// =====================================================================

export type RelationshipBatchResult = ActionResult<{
  batchId: string;
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  reconciliationRequired: number;
  remaining: number;
  summary: string;
}>;

/**
 * Confirm and run a batch of relationship mutations.
 *
 * The operator's selection is snapshotted into action rows, the batch is
 * confirmed (which freezes membership at the database level), and ONLY
 * those rows are processed. A candidate imported while this runs cannot
 * join: the trigger on `bluesky_relationship_actions` refuses an insert
 * carrying a confirmed batch id, and the processor is handed a fixed
 * array rather than a query.
 *
 * A single Follow/Unfollow is the same path with one selected id, so
 * there is one code path to reason about rather than two.
 */
async function runRelationshipBatch(
  actionType: BlueskyActionType,
  formData: FormData,
): Promise<RelationshipBatchResult> {
  const operatorAccountId = String(formData.get("operator_account_id") ?? "");
  const candidateIds = [
    ...new Set(formData.getAll("candidate_id").map(String).filter(Boolean)),
  ];

  const ctx = await requireRelationshipContext(
    operatorAccountId,
    "connect_platforms",
  );
  if (ctx.kind !== "ok") return actionFail(ctx.message);

  // Size gate, server-side and before anything else costly.
  //
  // The UI caps selection at the same constant, but that is a
  // convenience, not a control: a FormData is trivially forged and
  // arrives here with however many candidate_id fields the caller
  // chose. This rejects an oversized submission before a session is
  // resolved, before a row is written, and before a single provider
  // call — the count is checked, not the client's claim about it.
  const size = checkBatchSize(candidateIds.length);
  if (!size.ok) return actionFail(size.reason);

  const session = await resolveRelationshipSession({
    workspaceId: ctx.workspaceId,
    accountId: ctx.operatorAccountId,
  });
  if (!session.ok) return actionFail(session.message);

  // Load the selected candidates, workspace- AND identity-scoped. Ids
  // that do not resolve here are silently dropped rather than acted on.
  const candidates = await getCandidatesByIds(
    ctx.workspaceId,
    ctx.operatorAccountId,
    candidateIds,
  );
  if (candidates.length === 0) {
    return actionFail("None of the selected accounts are in this workspace.");
  }

  // Protected accounts are removed from an unfollow batch BEFORE any row
  // is written, so a protected relationship never even appears in the
  // batch's membership. The executor refuses them again independently.
  const eligible =
    actionType === "unfollow"
      ? candidates.filter((c) => !c.protected)
      : candidates;
  const protectedExcluded = candidates.length - eligible.length;

  if (eligible.length === 0) {
    return actionFail(
      "Every selected account is protected. Protected relationships are never unfollowed.",
    );
  }

  const batch = await createBatch({
    workspaceId: ctx.workspaceId,
    operatorAccountId: ctx.operatorAccountId,
    actionType,
    createdBy: ctx.userId,
  });

  const created = [];
  let duplicates = 0;
  for (const candidate of eligible) {
    // Source attribution is denormalised onto the action at request
    // time: bluesky_candidate_sources keeps changing as imports run, and
    // history has to record what was true when the operator acted.
    const sourceIds = await getCandidateSourceIds(
      ctx.workspaceId,
      candidate.id,
    );
    try {
      created.push(
        await createAction({
          workspaceId: ctx.workspaceId,
          operatorAccountId: ctx.operatorAccountId,
          candidateId: candidate.id,
          batchId: batch.id,
          actionType,
          subjectDid: candidate.subject_did,
          subjectHandleAtAction: candidate.handle,
          actorDid: session.actorDid,
          actorHandleAtAction: session.actorHandle,
          sourceTargetProfileIds: sourceIds,
          initiatedBy: ctx.userId,
          initiatorKind: candidateIds.length === 1 ? "operator_single" : "operator_batch",
        }),
      );
    } catch (err) {
      if (err instanceof DuplicateActiveActionError) {
        // Already in flight. Skipping is correct: a second follow would
        // create a second follow record for one account.
        duplicates += 1;
        continue;
      }
      if (err instanceof BatchMembershipFrozenError) {
        return actionFail(
          "That batch is already confirmed and its membership cannot change.",
        );
      }
      throw err;
    }
  }

  if (created.length === 0) {
    await updateBatchProgress({
      workspaceId: ctx.workspaceId,
      batchId: batch.id,
      status: "completed",
      processed: 0,
      succeeded: 0,
      failed: 0,
      reconciliationRequired: 0,
      finishedAt: new Date().toISOString(),
    });
    return actionFail(
      duplicates > 0
        ? `All ${duplicates} selected account(s) already have a ${actionType} in progress.`
        : "Nothing to do.",
    );
  }

  // Freeze membership. After this point the trigger refuses any further
  // insert into this batch.
  await confirmBatch({
    workspaceId: ctx.workspaceId,
    batchId: batch.id,
    requestedCount: created.length,
    confirmedBy: ctx.userId,
  });

  // Read back the confirmed membership rather than trusting the in-memory
  // list, so what runs is exactly what the database says was confirmed.
  const confirmedActions = await listBatchActions(ctx.workspaceId, batch.id);

  const candidateMap: RelationshipStateByDid = new Map(
    candidates.map((c) => [
      c.subject_did,
      {
        subject_did: c.subject_did,
        relationship_state: c.relationship_state,
        protected: c.protected,
        follow_rkey: c.follow_rkey,
        follow_cid: c.follow_cid,
      },
    ]),
  );

  await updateBatchProgress({
    workspaceId: ctx.workspaceId,
    batchId: batch.id,
    status: "running",
    processed: 0,
    succeeded: 0,
    failed: 0,
    reconciliationRequired: 0,
    startedAt: new Date().toISOString(),
  });

  const progress = await processBatchActions({
    ctx: {
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      session,
    },
    actionType,
    actions: confirmedActions,
    candidates: candidateMap,
  });

  await updateBatchProgress({
    workspaceId: ctx.workspaceId,
    batchId: batch.id,
    status: progress.halted ? "paused" : "completed",
    processed: progress.processed,
    succeeded: progress.succeeded,
    failed: progress.failed,
    reconciliationRequired: progress.reconciliationRequired,
    stopReason: progress.halted ? "provider" : null,
    lastError: progress.haltReason,
    finishedAt: progress.halted ? null : new Date().toISOString(),
  });

  await recordActivity({
    workspaceId: ctx.workspaceId,
    eventType: `bluesky_relationships.${actionType}_batch`,
    entityType: "bluesky_action_batch",
    entityId: batch.id,
    title: `Bluesky ${actionType}: ${progress.succeeded} of ${confirmedActions.length}`,
    description: progress.haltReason,
    metadata: {
      action_type: actionType,
      requested: confirmedActions.length,
      succeeded: progress.succeeded,
      failed: progress.failed,
      skipped: progress.skipped,
      reconciliation_required: progress.reconciliationRequired,
    },
  }).catch(() => undefined);

  revalidatePath(RELATIONSHIPS_PATH);

  const notes: string[] = [
    `${progress.succeeded} of ${confirmedActions.length} ${actionType === "follow" ? "followed" : "unfollowed"}.`,
  ];
  if (progress.skipped > 0) notes.push(`${progress.skipped} skipped.`);
  if (progress.failed > 0) notes.push(`${progress.failed} failed.`);
  if (progress.reconciliationRequired > 0) {
    notes.push(
      `${progress.reconciliationRequired} need reconciliation — Bluesky did not confirm the outcome and nothing was re-sent.`,
    );
  }
  if (duplicates > 0) {
    notes.push(`${duplicates} already had an action in progress.`);
  }
  if (protectedExcluded > 0) {
    notes.push(`${protectedExcluded} protected account(s) excluded.`);
  }
  if (progress.halted) {
    notes.push(
      `Stopped early: ${progress.haltReason ?? "provider limit"}. ${progress.remaining} not attempted; progress is saved.`,
    );
  }

  return actionOk({
    batchId: batch.id,
    requested: confirmedActions.length,
    succeeded: progress.succeeded,
    failed: progress.failed,
    skipped: progress.skipped,
    reconciliationRequired: progress.reconciliationRequired,
    remaining: progress.remaining,
    summary: notes.join(" "),
  });
}

export async function followSelectedAction(
  _prev: RelationshipBatchResult,
  formData: FormData,
): Promise<RelationshipBatchResult> {
  try {
    return await runRelationshipBatch("follow", formData);
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "The follow batch could not run.",
    );
  }
}

export async function unfollowSelectedAction(
  _prev: RelationshipBatchResult,
  formData: FormData,
): Promise<RelationshipBatchResult> {
  try {
    return await runRelationshipBatch("unfollow", formData);
  } catch (err) {
    return actionFail(
      err instanceof Error ? err.message : "The unfollow batch could not run.",
    );
  }
}
