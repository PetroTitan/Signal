import "server-only";
/**
 * Executing relationship mutations.
 *
 * This is the only module in Signal that creates or deletes an
 * `app.bsky.graph.follow` record. It is deliberately small and has no
 * scheduler, no queue worker, no cron entry point and no background
 * loop: every function here runs inside a request that an operator
 * started.
 *
 * WHAT THIS MODULE WILL NOT DO, BY CONSTRUCTION
 * ---------------------------------------------
 *   - It has no timer, no recursion and no retry of a provider call.
 *     A mutation is attempted exactly once per action row.
 *   - It cannot add members to a batch. It reads the action rows that
 *     already exist, and the database trigger refuses inserts into a
 *     confirmed batch anyway.
 *   - It has no randomised delay. Pacing between requests is a single
 *     declared constant, applied uniformly, because its purpose is to
 *     be gentle with the provider rather than to look human.
 *   - It never derives a follow record key.
 *   - It never re-sends a mutation whose outcome it could not read.
 *
 * PACING
 * ------
 * `INTER_REQUEST_MS` spaces successive mutations. It is fixed and
 * declared, not jittered: the point is to stay well inside a published
 * limit, and a random delay would be an attempt to disguise the
 * traffic's shape, which this milestone explicitly refuses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFollowRecord,
  deleteFollowRecord,
  isRefreshableAuthFailure,
  type GraphFailure,
  getRelationships,
  type RateLimitSnapshot,
} from "./atproto-graph";
import {
  classifyFollowOutcome,
  classifyUnfollowOutcome,
  looksLikeAlreadyExists,
  preflightFollow,
  preflightUnfollow,
  reconcileFollow,
  reconcileUnfollow,
  type MutationOutcome,
  type ReconciliationResult,
} from "./mutation-outcome";
import {
  relationshipsUnavailable,
  resolveRelationship,
  type ResolvedRelationship,
} from "./relationship-state";
import type { RelationshipSession } from "./session.server";
import {
  updateAction,
  updateCandidateRelationship,
} from "@/repositories/bluesky-relationship-repository";
import type {
  BlueskyActionStatus,
  BlueskyActionType,
  BlueskyCandidateRow,
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
} from "@/lib/supabase/types";

/** Fixed spacing between mutations. Declared, uniform, not jitter. */
export const INTER_REQUEST_MS = 1_000;

/**
 * Stop a batch with this much of the provider's window left, rather
 * than running into a refusal. Fewer requests, and the batch stops in a
 * state it can be resumed from.
 */
export const MUTATION_RATE_LIMIT_FLOOR = 20;

export interface ExecuteActionResult {
  actionId: string;
  subjectDid: string;
  status: BlueskyActionStatus;
  /** Set when the batch must stop rather than continue to the next row. */
  halt: { reason: string; resumable: boolean } | null;
  message: string | null;
  rateLimit: RateLimitSnapshot | null;
}

interface ExecuteContext {
  workspaceId: string;
  operatorAccountId: string;
  session: RelationshipSession;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}


// =====================================================================
// One refresh, one retry — and never more
// =====================================================================

/**
 * Send a mutation; if the session is refused in a way a refresh can
 * clear, renew it once and send the same mutation again.
 *
 * `refreshOnce()` has existed since the session layer was written and
 * had no production caller: every expired token arrived as
 * `HTTP 400 {"error":"ExpiredToken"}`, which the status-keyed
 * classifier called a provider error, so the refresh path was never
 * reached. The stored refresh token was never spent and the operator
 * was told the follow had failed.
 *
 * Bounded by construction, not by counting:
 *
 *   - the provider is called at most twice, because there is one
 *     conditional retry and no loop;
 *   - the session is refreshed at most once, because the session a
 *     refresh returns has `refreshAllowed: false` and its own
 *     `refreshOnce()` refuses. Nothing here tracks a counter.
 *
 * The refreshed session is handed back so the caller can adopt it for
 * the rest of the batch — otherwise every remaining member would repeat
 * the same expired-token round trip.
 */
interface RefreshedAttempt<T> {
  result: T;
  /** The renewed session, when one was obtained. */
  refreshedSession: RelationshipSession | null;
  /** Set when the refresh itself failed; the batch must stop. */
  reauthorization: string | null;
}

async function mutateWithOneRefresh<T extends { ok: boolean }>(
  ctx: ExecuteContext,
  run: (session: RelationshipSession) => Promise<T>,
): Promise<RefreshedAttempt<T>> {
  const session = ctx.session;
  const first = await run(session);
  if (first.ok || !isRefreshableAuthFailure(first as unknown as GraphFailure)) {
    return { result: first, refreshedSession: null, reauthorization: null };
  }

  const renewed = await session.refreshOnce();
  if (!renewed.ok) {
    // The connection has already been marked expired by the refresh
    // itself. Returning the ORIGINAL failure keeps the outcome
    // classification honest: the mutation was refused, and it is an
    // auth refusal, which halts the batch non-resumably.
    return {
      result: first,
      refreshedSession: null,
      reauthorization: renewed.message,
    };
  }

  // Adopted for the rest of the batch by assignment, not by threading
  // it back through every return path — the context object belongs to
  // the batch loop, so later members pick it up with nothing to forget.
  ctx.session = renewed;
  return {
    result: await run(renewed),
    refreshedSession: renewed,
    reauthorization: null,
  };
}

/**
 * Read the provider's relationship truth for ONE subject.
 *
 * Used for reconciliation, so it is deliberately a fresh read rather
 * than anything cached, and a failed read yields `unknown` — never an
 * assumption that the mutation did or did not land.
 */
async function readTruth(
  ctx: ExecuteContext,
  subjectDid: string,
): Promise<ResolvedRelationship> {
  const result = await getRelationships({
    actor: ctx.session.actorDid,
    others: [subjectDid],
    appView: ctx.appView,
    fetchImpl: ctx.fetchImpl,
  });
  if (!result.ok) {
    return relationshipsUnavailable([subjectDid], result)[0];
  }
  const observation = result.observations.get(subjectDid);
  return observation
    ? resolveRelationship(observation)
    : {
        did: subjectDid,
        state: "unknown",
        followRecord: null,
        unknownReason:
          "Bluesky returned no relationship entry for this account, so it is unknown.",
      };
}

/** Persist a reconciliation onto both the action and the candidate. */
async function persistReconciliation(
  ctx: ExecuteContext,
  action: BlueskyRelationshipActionRow,
  reconciliation: ReconciliationResult,
  providerFailureMessage: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await updateAction({
    workspaceId: ctx.workspaceId,
    actionId: action.id,
    status: reconciliation.status,
    ...(reconciliation.followRecord
      ? {
          followUri: reconciliation.followRecord.uri,
          followRkey: reconciliation.followRecord.rkey,
        }
      : {}),
    providerErrorMessage: providerFailureMessage,
    reconciledState: reconciliation.observedState,
    reconciledAt: now,
    reconciliationNote: reconciliation.note,
    finishedAt: now,
    db: ctx.db,
  });

  await updateCandidateRelationship({
    workspaceId: ctx.workspaceId,
    operatorAccountId: ctx.operatorAccountId,
    subjectDid: action.subject_did,
    state: reconciliation.observedState,
    error:
      reconciliation.observedState === "unknown" ? reconciliation.note : null,
    // Only write a record identity the provider actually gave us.
    ...(reconciliation.followRecord
      ? {
          followUri: reconciliation.followRecord.uri,
          followRkey: reconciliation.followRecord.rkey,
          followRecordSource: "reconciled" as const,
        }
      : {}),
    db: ctx.db,
  });
}

// =====================================================================
// Reconcile now — reads only
// =====================================================================

export interface ReconciledActionReport {
  actionId: string;
  subjectDid: string;
  subjectHandle: string | null;
  operation: BlueskyActionType;
  /** What the read observed. */
  observedState: BlueskyRelationshipState;
  /** The action's status after the read. */
  status: BlueskyActionStatus;
  note: string;
  reconciledAt: string;
}

/**
 * Read Bluesky's relationship truth for every MANUAL action of this
 * identity that is `reconciliation_required`, and settle what a read
 * can settle. Sends nothing: there is no code path from here to
 * `createFollowRecord` or `deleteFollowRecord`, and the only writes are
 * the action's reconciliation columns and the candidate's observed
 * state.
 *
 * An action the read still cannot decide stays `reconciliation_required`
 * with a fresh note and timestamp, so the operator sees that it was
 * looked at and when. Campaign actions are reconciled by their own
 * dispatcher in `reconcileOnly` mode, under the campaign's claim
 * discipline; they are excluded here so a member is never worked by
 * two paths at once.
 */
export async function reconcileUnresolvedActions(input: {
  workspaceId: string;
  operatorAccountId: string;
  session: RelationshipSession;
  actions: BlueskyRelationshipActionRow[];
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<ReconciledActionReport[]> {
  const ctx: ExecuteContext = {
    workspaceId: input.workspaceId,
    operatorAccountId: input.operatorAccountId,
    session: input.session,
    appView: input.appView,
    fetchImpl: input.fetchImpl,
    db: input.db,
  };
  const reports: ReconciledActionReport[] = [];
  for (const action of input.actions) {
    if (action.status !== "reconciliation_required") continue;
    if (action.campaign_id) continue;
    if (action.workspace_id !== input.workspaceId) continue;
    if (action.operator_account_id !== input.operatorAccountId) continue;

    const truth = await readTruth(ctx, action.subject_did);
    const reconciliation =
      action.action_type === "follow"
        ? reconcileFollow(truth)
        : reconcileUnfollow(truth);
    await persistReconciliation(ctx, action, reconciliation, null);
    reports.push({
      actionId: action.id,
      subjectDid: action.subject_did,
      subjectHandle: action.subject_handle_at_action,
      operation: action.action_type,
      observedState: reconciliation.observedState,
      status: reconciliation.status,
      note: reconciliation.note,
      reconciledAt: new Date().toISOString(),
    });
  }
  return reports;
}

/**
 * A halt: the provider refused to work, and NOTHING was applied.
 *
 * The row is reset to `pending` rather than left `running`. It was
 * marked running immediately before the request, and a row abandoned in
 * `running` is doubly wrong: it reads as "in flight" forever, and the
 * one-active-action index keeps blocking a legitimate retry of an
 * action that is not actually in flight. `pending` is the honest state
 * — queued, not attempted — and it is what a resume picks up.
 */
async function halted(
  ctx: ExecuteContext,
  action: BlueskyRelationshipActionRow,
  outcome: Extract<MutationOutcome, { kind: "halt" }>,
): Promise<ExecuteActionResult> {
  await updateAction({
    workspaceId: ctx.workspaceId,
    actionId: action.id,
    status: "pending",
    startedAt: null,
    providerStatusCode: outcome.failure.status,
    providerErrorCode: outcome.failure.errorCode,
    providerErrorMessage: outcome.failure.message,
    db: ctx.db,
  });
  return {
    actionId: action.id,
    subjectDid: action.subject_did,
    status: "pending",
    halt: { reason: outcome.failure.message, resumable: outcome.resumable },
    message: outcome.failure.message,
    rateLimit: outcome.failure.rateLimit,
  };
}

// =====================================================================
// Follow
// =====================================================================

export async function executeFollowAction(
  ctx: ExecuteContext,
  action: BlueskyRelationshipActionRow,
  candidate: Pick<
    BlueskyCandidateRow,
    "relationship_state" | "subject_did"
  >,
): Promise<ExecuteActionResult> {
  const preflight = preflightFollow({
    subjectDid: action.subject_did,
    actorDid: ctx.session.actorDid,
    currentState: candidate.relationship_state,
  });
  if (!preflight.proceed) {
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: preflight.status,
      providerErrorMessage: preflight.reason,
      finishedAt: new Date().toISOString(),
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: preflight.status,
      halt: null,
      message: preflight.reason,
      rateLimit: null,
    };
  }

  await updateAction({
    workspaceId: ctx.workspaceId,
    actionId: action.id,
    status: "running",
    startedAt: new Date().toISOString(),
    db: ctx.db,
  });

  const attempt = await mutateWithOneRefresh(ctx, (session) =>
    createFollowRecord({
      accessJwt: session.accessJwt,
      actorDid: session.actorDid,
      subjectDid: action.subject_did,
      pds: session.service,
      fetchImpl: ctx.fetchImpl,
    }),
  );
  const result = attempt.result;
  const outcome = classifyFollowOutcome(result);

  // The refresh was attempted and refused. The connection is already
  // marked expired by `refreshOnce`; stop the batch here rather than
  // spending a provider call per remaining member to be told the same
  // thing. `resumable: false` — resuming needs a person to sign in.
  if (attempt.reauthorization) {
    return {
      ...(await halted(ctx, action, {
        kind: "halt",
        failure: result.ok
          ? ({ ok: false, kind: "auth", status: 0, errorCode: null,
                message: attempt.reauthorization, rateLimit: null } as GraphFailure)
          : result,
        resumable: false,
      })),
      halt: { reason: attempt.reauthorization, resumable: false },
    };
  }

  if (outcome.kind === "applied") {
    const now = new Date().toISOString();
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: "succeeded",
      followUri: outcome.followRecord?.uri ?? null,
      followRkey: outcome.followRecord?.rkey ?? null,
      followCid: outcome.followRecord?.cid ?? null,
      finishedAt: now,
      db: ctx.db,
    });
    await updateCandidateRelationship({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      subjectDid: action.subject_did,
      // If they already followed us, following back makes it mutual.
      // Otherwise we know exactly one direction.
      state:
        candidate.relationship_state === "follows_you" ? "mutual" : "following",
      followUri: outcome.followRecord?.uri ?? null,
      followRkey: outcome.followRecord?.rkey ?? null,
      followCid: outcome.followRecord?.cid ?? null,
      followRecordSource: "create_record",
      followedAt: now,
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: "succeeded",
      halt: null,
      message: null,
      rateLimit: result.ok ? result.rateLimit : null,
    };
  }

  if (outcome.kind === "halt") return halted(ctx, action, outcome);

  // A PDS that enforces follow uniqueness reports "already exists". The
  // relationship is already in the desired state, so this is not a
  // failure — but the existing record's identity is unknown to us, so
  // we reconcile to learn it rather than recording a bare success.
  if (outcome.kind === "rejected" && looksLikeAlreadyExists(outcome.failure)) {
    const truth = await readTruth(ctx, action.subject_did);
    await persistReconciliation(
      ctx,
      action,
      reconcileFollow(truth),
      outcome.failure.message,
    );
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: reconcileFollow(truth).status,
      halt: null,
      message: "Bluesky reports this follow already exists; state reconciled.",
      rateLimit: outcome.failure.rateLimit,
    };
  }

  if (outcome.kind === "rejected") {
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: "failed",
      providerStatusCode: outcome.failure.status,
      providerErrorCode: outcome.failure.errorCode,
      providerErrorMessage: outcome.failure.message,
      finishedAt: new Date().toISOString(),
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: "failed",
      halt: null,
      message: outcome.failure.message,
      rateLimit: outcome.failure.rateLimit,
    };
  }

  // === Ambiguous. Read truth. Do NOT re-send. ===
  //
  // createRecord mints a new rkey per call, so a retry of a request that
  // actually succeeded would leave two follow records for one account —
  // one of which Signal has no row for and could never clean up.
  const truth = await readTruth(ctx, action.subject_did);
  const reconciliation = reconcileFollow(truth);
  await persistReconciliation(
    ctx,
    action,
    reconciliation,
    outcome.failure.message,
  );
  return {
    actionId: action.id,
    subjectDid: action.subject_did,
    status: reconciliation.status,
    halt: null,
    message: reconciliation.note,
    rateLimit: outcome.failure.rateLimit,
  };
}

// =====================================================================
// Unfollow
// =====================================================================

export async function executeUnfollowAction(
  ctx: ExecuteContext,
  action: BlueskyRelationshipActionRow,
  candidate: Pick<
    BlueskyCandidateRow,
    "relationship_state" | "protected" | "follow_rkey" | "follow_cid" | "subject_did"
  >,
): Promise<ExecuteActionResult> {
  // Protection is checked first and unconditionally.
  let rkey = candidate.follow_rkey;
  let cid = candidate.follow_cid;

  let preflight = preflightUnfollow({
    subjectDid: action.subject_did,
    currentState: candidate.relationship_state,
    protectedRelationship: candidate.protected,
    followRkey: rkey,
  });

  // Missing record key is the one preflight failure worth recovering
  // from: the provider knows the key even when we do not. Reconcile to
  // learn it, then re-run the preflight. Protection is NOT re-evaluated
  // here — a protected candidate has already been refused above and
  // never reaches this branch.
  if (!preflight.proceed && preflight.status === "failed" && !rkey && !candidate.protected) {
    const truth = await readTruth(ctx, action.subject_did);
    if (truth.followRecord) {
      rkey = truth.followRecord.rkey;
      cid = null; // getRelationships does not return a CID.
      await updateCandidateRelationship({
        workspaceId: ctx.workspaceId,
        operatorAccountId: ctx.operatorAccountId,
        subjectDid: action.subject_did,
        state: truth.state,
        followUri: truth.followRecord.uri,
        followRkey: truth.followRecord.rkey,
        followRecordSource: "reconciled",
        db: ctx.db,
      });
      preflight = preflightUnfollow({
        subjectDid: action.subject_did,
        currentState: truth.state,
        protectedRelationship: candidate.protected,
        followRkey: rkey,
      });
    } else {
      // The provider gave us no record either. Record what was observed
      // and stop; there is nothing safe to delete.
      await persistReconciliation(
        ctx,
        action,
        reconcileUnfollow(truth),
        preflight.reason,
      );
      return {
        actionId: action.id,
        subjectDid: action.subject_did,
        status: reconcileUnfollow(truth).status,
        halt: null,
        message: reconcileUnfollow(truth).note,
        rateLimit: null,
      };
    }
  }

  if (!preflight.proceed) {
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: preflight.status,
      providerErrorMessage: preflight.reason,
      finishedAt: new Date().toISOString(),
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: preflight.status,
      halt: null,
      message: preflight.reason,
      rateLimit: null,
    };
  }

  await updateAction({
    workspaceId: ctx.workspaceId,
    actionId: action.id,
    status: "running",
    followRkey: rkey,
    startedAt: new Date().toISOString(),
    db: ctx.db,
  });

  const attempt = await mutateWithOneRefresh(ctx, (session) =>
    deleteFollowRecord({
      accessJwt: session.accessJwt,
      actorDid: session.actorDid,
      rkey: rkey!,
      swapCid: cid,
      pds: session.service,
      fetchImpl: ctx.fetchImpl,
    }),
  );
  const result = attempt.result;
  const outcome = classifyUnfollowOutcome(result);

  // The refresh was attempted and refused. The connection is already
  // marked expired by `refreshOnce`; stop the batch here rather than
  // spending a provider call per remaining member to be told the same
  // thing. `resumable: false` — resuming needs a person to sign in.
  if (attempt.reauthorization) {
    return {
      ...(await halted(ctx, action, {
        kind: "halt",
        failure: result.ok
          ? ({ ok: false, kind: "auth", status: 0, errorCode: null,
                message: attempt.reauthorization, rateLimit: null } as GraphFailure)
          : result,
        resumable: false,
      })),
      halt: { reason: attempt.reauthorization, resumable: false },
    };
  }

  if (outcome.kind === "applied") {
    const now = new Date().toISOString();
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: "succeeded",
      finishedAt: now,
      db: ctx.db,
    });
    await updateCandidateRelationship({
      workspaceId: ctx.workspaceId,
      operatorAccountId: ctx.operatorAccountId,
      subjectDid: action.subject_did,
      // They may still follow us; removing our edge does not remove
      // theirs. Preserve that half of the truth.
      state:
        candidate.relationship_state === "mutual" ? "follows_you" : "not_following",
      // The record is gone; its identity is cleared so a future unfollow
      // cannot aim at a key that no longer exists.
      followUri: null,
      followRkey: null,
      followCid: null,
      followRecordSource: null,
      unfollowedAt: now,
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: "succeeded",
      halt: null,
      message: null,
      rateLimit: result.ok ? result.rateLimit : null,
    };
  }

  if (outcome.kind === "halt") return halted(ctx, action, outcome);

  if (outcome.kind === "rejected") {
    await updateAction({
      workspaceId: ctx.workspaceId,
      actionId: action.id,
      status: "failed",
      providerStatusCode: outcome.failure.status,
      providerErrorCode: outcome.failure.errorCode,
      providerErrorMessage: outcome.failure.message,
      finishedAt: new Date().toISOString(),
      db: ctx.db,
    });
    return {
      actionId: action.id,
      subjectDid: action.subject_did,
      status: "failed",
      halt: null,
      message: outcome.failure.message,
      rateLimit: outcome.failure.rateLimit,
    };
  }

  // Ambiguous. deleteRecord is idempotent, so a repeat would be
  // harmless — but it is still not sent automatically, because an
  // automatic loop that re-derives its target is how the wrong record
  // gets deleted. Read truth; let the operator decide.
  const truth = await readTruth(ctx, action.subject_did);
  const reconciliation = reconcileUnfollow(truth);
  await persistReconciliation(
    ctx,
    action,
    reconciliation,
    outcome.failure.message,
  );
  return {
    actionId: action.id,
    subjectDid: action.subject_did,
    status: reconciliation.status,
    halt: null,
    message: reconciliation.note,
    rateLimit: outcome.failure.rateLimit,
  };
}

// =====================================================================
// Batch processing
// =====================================================================

export interface BatchProgress {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  reconciliationRequired: number;
  /** Actions not attempted because the batch stopped. */
  remaining: number;
  halted: boolean;
  haltReason: string | null;
  resumable: boolean;
}

export type RelationshipStateByDid = Map<
  string,
  Pick<
    BlueskyCandidateRow,
    "relationship_state" | "protected" | "follow_rkey" | "follow_cid" | "subject_did"
  >
>;

/**
 * Process a FIXED list of action rows.
 *
 * The list is a parameter. This function does not query for more work,
 * cannot discover new candidates, and has no notion of the batch's
 * filter — which is what makes it structurally impossible for a newly
 * imported account to join a batch mid-flight.
 *
 * Stops early, keeping progress, when the provider rate-limits, when
 * the session dies, or when the remaining window falls below the floor.
 * Never retries, never speeds up, never adds jitter.
 */
export async function processBatchActions(input: {
  ctx: ExecuteContext;
  actionType: BlueskyActionType;
  actions: BlueskyRelationshipActionRow[];
  candidates: RelationshipStateByDid;
  /** Injectable so tests do not wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
}): Promise<BatchProgress> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const spacing = input.interRequestMs ?? INTER_REQUEST_MS;

  const progress: BatchProgress = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    reconciliationRequired: 0,
    remaining: input.actions.length,
    halted: false,
    haltReason: null,
    resumable: true,
  };

  for (let i = 0; i < input.actions.length; i += 1) {
    const action = input.actions[i];
    const candidate = input.candidates.get(action.subject_did) ?? {
      subject_did: action.subject_did,
      // A candidate row we cannot read is unknown, not not_following.
      relationship_state: "unknown" as BlueskyRelationshipState,
      protected: false,
      follow_rkey: null,
      follow_cid: null,
    };

    const result =
      input.actionType === "follow"
        ? await executeFollowAction(input.ctx, action, candidate)
        : await executeUnfollowAction(input.ctx, action, candidate);

    if (result.halt) {
      progress.halted = true;
      progress.haltReason = result.halt.reason;
      progress.resumable = result.halt.resumable;
      break;
    }

    progress.processed += 1;
    progress.remaining -= 1;
    switch (result.status) {
      case "succeeded":
        progress.succeeded += 1;
        break;
      case "failed":
        progress.failed += 1;
        break;
      case "skipped":
        progress.skipped += 1;
        break;
      case "reconciliation_required":
        progress.reconciliationRequired += 1;
        break;
      default:
        break;
    }

    // Stop before the provider's window runs out rather than after.
    const remaining = result.rateLimit?.remaining;
    if (
      typeof remaining === "number" &&
      remaining <= MUTATION_RATE_LIMIT_FLOOR
    ) {
      progress.halted = true;
      progress.haltReason = `Stopped with ${remaining} requests left in Bluesky's window. Progress is saved; continue when it resets.`;
      progress.resumable = true;
      break;
    }

    // Fixed spacing, and only between requests — never after the last.
    if (i < input.actions.length - 1 && spacing > 0) {
      await sleep(spacing);
    }
  }

  return progress;
}
