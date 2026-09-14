import "server-only";
/**
 * The unfollow worker: process one bounded chunk of a daily run.
 *
 * This is the ONLY code in the campaign system that deletes a follow
 * record, and it does so through the same provider client, with the
 * same spacing, as the manual per-row workflow. Nothing about the
 * Follow path is changed, weakened or bypassed by anything in this
 * file: it shares the reservation, the ledger, the consume-at-intent
 * transaction and settlement, and it has no way to create a follow.
 *
 * WHAT A CHUNK IS
 * ---------------
 * At most `MAX_RELATIONSHIP_BATCH_SIZE` members — the existing manual
 * limit, unchanged. That constant was justified by arithmetic against a
 * 60-second budget elsewhere; the cron route has a larger budget, so a
 * tick runs SEVERAL chunks rather than one bigger one. Raising it here
 * would silently re-tune a number decided somewhere else.
 *
 * THE FIVE THINGS THIS REFUSES TO DO
 * ----------------------------------
 *  1. It never follows. There is no create path in this file.
 *  2. It never deletes a record key it has not just read from the
 *     provider. A key stored at import is treated as a hint, never as
 *     the target — see `resolveDeleteTarget`.
 *  3. It never re-sends a delete whose outcome it could not read, even
 *     though `deleteRecord` is idempotent. Idempotence protects the
 *     REQUEST from repetition; it does not protect the world from
 *     having moved on between the two.
 *  4. It never acts on a member whose protection it has not re-checked
 *     inside the same transaction that creates the action row.
 *  5. It adds no jitter to request spacing. The fixed
 *     `INTER_REQUEST_MS` is the courtesy interval the manual path uses,
 *     and randomising it would be disguising traffic rather than
 *     pacing it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteFollowRecord,
  isRefreshableAuthFailure,
  getRelationships,
  type RateLimitSnapshot,
} from "@/core/bluesky-relationships/atproto-graph";
import { resolveRelationship } from "@/core/bluesky-relationships/relationship-state";
import { INTER_REQUEST_MS } from "@/core/bluesky-relationships/execute-actions.server";
import { MAX_RELATIONSHIP_BATCH_SIZE } from "@/core/bluesky-relationships/limits";
import type { RelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  bumpReconcileCount,
  completeCampaignAction,
  consumeMemberQuota,
  getCampaignActionRejection,
  releaseOwnedMembers,
  reopenCampaignAction,
  updateMember,
  type ClaimedMember,
} from "@/repositories/bluesky-campaign-repository";
import {
  isDefiniteRejectionCode,
  reconciliationBackoffMs,
  rejectedBeforeWrite,
} from "@/core/bluesky-campaigns/outcomes";
import {
  claimUnfollowAction,
  getMemberRecordIdentities,
  deferMember,
  markMemberProtected,
  recordAlreadyAbsent,
  setMemberRecordIdentity,
  type UnfollowPermit,
} from "@/repositories/bluesky-unfollow-repository";
import type { BlueskyFollowCampaignRow } from "@/lib/supabase/types";
import { resolveDeleteTarget } from "./record-identity";
import {
  backoffDelayMs,
  classifyUnfollowOutcome,
  MAX_MEMBER_ATTEMPTS,
  outcomeFromGraphFailure,
  type UnfollowOutcomeKind,
  type NextAction,
} from "./outcomes";

/** Chunk size. Deliberately the existing manual maximum. */
export const UNFOLLOW_CHUNK_SIZE = MAX_RELATIONSHIP_BATCH_SIZE;

/** Lease length. Matches the follow worker's, for the same reasons. */
export const LEASE_SECONDS = 300;
export const DISPATCH_LEASE_SECONDS = 360;

/**
 * How long an unresolved provider intent waits before it is eligible
 * again.
 *
 * A reconciliation costs no quota and sends nothing, which makes it
 * tempting to do immediately — and that is the trap. A member whose
 * outcome is unknown is claimable by the reconciliation takeover
 * REGARDLESS of headroom, so without a delay one such member is
 * re-claimed the instant its lease clears, every iteration, for the
 * whole tick. The reads are cheap individually and the queue behind it
 * never moves.
 *
 * Ten minutes is long enough that a tick cannot revisit the same member
 * twice, and short enough that an ambiguity is resolved within the
 * hour rather than tomorrow.
 */
export const RECONCILIATION_BACKOFF_MS = 10 * 60_000;

export interface ChunkOutcomeCounts {
  /** Members another worker owned, which this one left alone. */
  denied: number;
  attempted: number;
  succeeded: number;
  alreadyNotFollowing: number;
  protectedCount: number;
  conflicts: number;
  skipped: number;
  failed: number;
  /** Quota units consumed. NOT the same as `attempted`. */
  quotaConsumed: number;
  /** Follow records actually DELETED — what the provider counts. */
  recordsDeleted: number;
}

export interface ChunkResult extends ChunkOutcomeCounts {
  /**
   * The session the NEXT chunk must use — possibly renewed by this one.
   * Not carrying it is how the follow dispatcher came to refresh once
   * per chunk from an expired session (incident, 2026-09-14).
   */
  session: RelationshipSession;
  claimed: number;
  consecutiveFailures: number;
  next: NextAction;
  rateLimit: RateLimitSnapshot | null;
}

const emptyCounts = (): ChunkOutcomeCounts => ({
  denied: 0,
  attempted: 0,
  succeeded: 0,
  alreadyNotFollowing: 0,
  protectedCount: 0,
  conflicts: 0,
  skipped: 0,
  failed: 0,
  quotaConsumed: 0,
  recordsDeleted: 0,
});

export interface ProcessChunkInput {
  campaign: BlueskyFollowCampaignRow;
  runId: string;
  session: RelationshipSession;
  /**
   * The members this chunk may process — already claimed and already
   * covered by a quota reservation taken by the dispatcher.
   *
   * Passed in rather than claimed here: a worker that claimed its own
   * work could claim more than was reserved, which is the hole that let
   * two dispatchers exceed the daily quota in the follow subsystem.
   */
  members: ClaimedMember[];
  /** The reservation that paid for these members. */
  reservationId: string;
  /** Quota units still available. Bounds the loop, per member. */
  quotaRemaining: number;
  /**
   * This chunk came from a reconciliation takeover: it may only READ.
   *
   * WHAT ACTUALLY PREVENTS A DELETE HERE IS NOT THIS FLAG. A
   * reconciliation reservation carries ZERO units, and
   * `consume_bluesky_member_quota` refuses a reservation with nothing
   * left to spend — so the provider cannot be reached whatever this
   * says. That refusal is the guarantee, and it is asserted directly.
   *
   * This flag exempts such a chunk from the per-member quota check
   * below. Today `quotaRemaining` is the number of members handed back,
   * so the check would not bite in any case — a mutation control
   * confirmed that removing this changes nothing observable. It is kept
   * because the relationship between "units reserved" and "members
   * handed back" is a property of the caller, not an invariant: the
   * moment `quotaRemaining` is derived from the reservation's own count
   * instead, `0 >= 0` breaks the chunk on its first iteration, the
   * members are released, the next reservation hands back the same
   * ones, and the pass spins while the ambiguity never resolves.
   *
   * Stated here rather than deleted, because the failure it guards is
   * silent: the queue simply stops moving.
   */
  reconciliationOnly?: boolean;
  consecutiveFailures: number;
  claimedBy: string;
  initiatedBy?: string | null;
  /** The instant the tick is working from, so timestamps agree. */
  now: Date;
  /** Wall clock after provider I/O, so a backoff starts when it should. */
  currentTime?: () => Date;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
}

type LiveRelationship =
  | { state: "following"; uri: string; rkey: string }
  | { state: "not_following" }
  | { state: "unknown"; reason: string };

/**
 * Read relationship truth for a chunk, INCLUDING the record identity.
 *
 * This is the step that makes an unfollow exact. `getRelationships`
 * returns `followingUri` — the AT-URI of OUR follow record — and
 * `resolveRelationship` parses it into `{ uri, rkey }`. That rkey came
 * from the provider a moment ago, so it names the record that exists
 * NOW, not the one that existed when the queue was built.
 *
 * A failed lookup is UNKNOWN for every DID, never "not following". The
 * whole relationship subsystem is built on that distinction: a failure
 * to observe is not an observation of absence, and collapsing them here
 * would turn an outage into a wave of members wrongly recorded as
 * already unfollowed.
 */
async function readRelationships(
  input: ProcessChunkInput,
  dids: string[],
): Promise<Map<string, LiveRelationship>> {
  const out = new Map<string, LiveRelationship>();
  if (dids.length === 0) return out;

  const result = await getRelationships({
    actor: input.session.actorDid,
    others: dids,
    appView: input.appView,
    fetchImpl: input.fetchImpl,
  });

  if (!result.ok) {
    for (const did of dids) {
      out.set(did, {
        state: "unknown",
        reason:
          "Bluesky did not answer the relationship lookup, so this is unknown — not confirmed as unfollowed.",
      });
    }
    return out;
  }

  for (const did of dids) {
    const observation = result.observations.get(did);
    if (!observation) {
      out.set(did, {
        state: "unknown",
        reason: "Bluesky returned no relationship for this account.",
      });
      continue;
    }
    const resolved = resolveRelationship(observation);
    if (resolved.state === "unknown") {
      out.set(did, {
        state: "unknown",
        reason: resolved.unknownReason ?? "The relationship is unknown.",
      });
      continue;
    }
    if (resolved.state === "following" || resolved.state === "mutual") {
      if (!resolved.followRecord) {
        // We know the edge exists but not how to remove it: the URI did
        // not parse. Unknown rather than following, because "following
        // with no way to identify the record" is not a state this
        // worker can act on, and guessing a key is the one thing it
        // must never do.
        out.set(did, {
          state: "unknown",
          reason:
            "Bluesky reports a follow but did not return a usable record address, so the exact record cannot be identified.",
        });
        continue;
      }
      out.set(did, {
        state: "following",
        uri: resolved.followRecord.uri,
        rkey: resolved.followRecord.rkey,
      });
      continue;
    }
    // `not_following` and `follows_you` both mean WE do not follow them.
    out.set(did, { state: "not_following" });
  }
  return out;
}

/**
 * Process one chunk.
 *
 * Reads truth once for the whole chunk, then walks it sequentially with
 * the standard spacing, persisting every outcome as it happens and
 * releasing anything it did not touch.
 */
export async function processUnfollowChunk(
  input: ProcessChunkInput,
): Promise<ChunkResult> {
  const counts = emptyCounts();
  let consecutiveFailures = input.consecutiveFailures;
  let next: NextAction = { kind: "continue" };
  let rateLimit: RateLimitSnapshot | null = null;

  const claimed = input.members;
  if (claimed.length === 0) {
    return {
      ...counts,
      session: input.session,
      claimed: 0,
      consecutiveFailures,
      next,
      rateLimit,
    };
  }

  // Everything leased but not yet resolved. Anything still here at the
  // end goes back to the queue WITHOUT consuming an attempt.
  const untouched = new Set(claimed.map((m) => m.id));

  const stored = await getMemberRecordIdentities({
    workspaceId: input.campaign.workspace_id,
    campaignId: input.campaign.id,
    memberIds: claimed.map((m) => m.id),
    db: input.db,
  });

  const live = await readRelationships(
    input,
    claimed.map((m) => m.subject_did),
  );

  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const spacing = input.interRequestMs ?? INTER_REQUEST_MS;
  const clock = input.currentTime ?? (() => input.now);

  for (let i = 0; i < claimed.length; i += 1) {
    const member = claimed[i];

    // Quota is re-checked PER MEMBER, not only per chunk: a chunk of 20
    // with 3 units left must attempt 3, not 20 and not 0.
    //
    // A reconciliation chunk is exempt. Its members have already spent
    // their units, it can only read, and applying a budget of zero to
    // work that costs nothing would leave the ambiguity standing
    // forever — which is the one outcome worse than spending a unit.
    if (
      !input.reconciliationOnly &&
      counts.quotaConsumed >= input.quotaRemaining
    ) {
      break;
    }

    const storedRecord = stored.get(member.id) ?? {
      memberId: member.id,
      uri: null,
      rkey: member.provider_record_rkey,
      cid: null,
      source: null,
    };
    const observed = live.get(member.subject_did) ?? {
      state: "unknown" as const,
      reason: "No relationship was read for this account.",
    };

    const target = resolveDeleteTarget({
      actorDid: input.session.actorDid,
      stored: {
        uri: storedRecord.uri,
        rkey: storedRecord.rkey,
        cid: storedRecord.cid,
      },
      live: observed,
    });

    // ── The relationship could not be read. NOTHING is sent.
    if (target.kind === "unknown") {
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "retryable",
        {
          kind: "retryable_transport_failure",
          errorCode: "relationship_unknown",
          errorMessage: target.reason,
        },
        member.attempt_count,
        clock(),
      );
      // Not counted as a failure for the breaker: a lookup we could not
      // complete says nothing about whether unfollowing is working.
      if (i < claimed.length - 1 && spacing > 0) await sleep(spacing);
      continue;
    }

    // ── Already not following. The neutral success.
    if (target.kind === "already_absent") {
      untouched.delete(member.id);
      const recorded = await recordAlreadyAbsent({
        workspaceId: input.campaign.workspace_id,
        campaignId: input.campaign.id,
        runId: input.runId,
        memberId: member.id,
        operatorAccountId: input.campaign.operator_account_id,
        subjectDid: member.subject_did,
        subjectHandle: member.current_handle,
        actorDid: input.session.actorDid,
        actorHandle: input.session.actorHandle,
        initiatedBy: input.initiatedBy ?? null,
        db: input.db,
      });
      if (recorded.kind === "protected") {
        counts.protectedCount += 1;
      } else if (recorded.kind === "already_not_following") {
        counts.alreadyNotFollowing += 1;
        consecutiveFailures = 0;
      }
      continue;
    }

    // ── A target was offered and refused. Terminal, nothing sent.
    if (target.kind === "refused") {
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "failed_structural",
        {
          kind: "no_record_target",
          errorCode: target.code,
          errorMessage: target.message,
        },
        member.attempt_count,
        clock(),
      );
      counts.failed += 1;
      continue;
    }

    // ── A real, freshly-resolved delete target.
    //
    // Persisted onto the member row BEFORE the action is claimed, so
    // that even if everything after this line is lost, the record
    // Signal intended to delete is recorded and auditable.
    if (
      target.replacedStoredKey ||
      storedRecord.uri !== target.identity.uri ||
      storedRecord.source !== "relationship_read"
    ) {
      await setMemberRecordIdentity({
        workspaceId: input.campaign.workspace_id,
        memberId: member.id,
        uri: target.identity.uri,
        rkey: target.identity.rkey,
        cid: target.identity.cid,
        source: "relationship_read",
        db: input.db,
      });
    }

    const claim = await claimUnfollowAction({
      workspaceId: input.campaign.workspace_id,
      campaignId: input.campaign.id,
      runId: input.runId,
      memberId: member.id,
      operatorAccountId: input.campaign.operator_account_id,
      subjectDid: member.subject_did,
      subjectHandle: member.current_handle,
      actorDid: input.session.actorDid,
      actorHandle: input.session.actorHandle,
      recordUri: target.identity.uri,
      recordRkey: target.identity.rkey,
      recordCid: target.identity.cid,
      initiatedBy: input.initiatedBy ?? null,
      db: input.db,
    });

    if (claim.kind === "denied") {
      // Not ours. Not terminal, and NOT reconciliation: no provider
      // intent exists for this worker and nothing has been sent on its
      // behalf, so recording either would put a fiction in History.
      //
      // The member is NOT handed back either. Releasing it would return
      // it to the queue, where this same pass would reserve it and be
      // denied again — the follow subsystem's first version of this fix
      // spun on exactly that. The lease lapses on its own.
      untouched.delete(member.id);
      counts.denied += 1;
      continue;
    }

    if (claim.kind === "protected") {
      untouched.delete(member.id);
      await markMemberProtected({
        workspaceId: input.campaign.workspace_id,
        memberId: member.id,
        reason: claim.reason,
        db: input.db,
      });
      counts.protectedCount += 1;
      continue;
    }

    if (claim.kind === "conflict") {
      // FAIL CLOSED, and say so. Another unresolved intention exists
      // for this identity and subject — an active follow campaign, or a
      // manual action. Nothing is sent; the operator is told which
      // person is contested.
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "failed_structural",
        {
          kind: "conflict",
          errorCode: "follow_unfollow_conflict",
          errorMessage:
            "Another follow or unfollow for this profile is still unresolved on this account, so nothing was sent. Resolve it, then re-queue this profile.",
        },
        member.attempt_count,
        clock(),
      );
      counts.conflicts += 1;
      continue;
    }

    if (claim.kind === "no_record_target") {
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "failed_structural",
        {
          kind: "no_record_target",
          errorCode: "no_record_target",
          errorMessage: claim.reason,
        },
        member.attempt_count,
        clock(),
      );
      counts.failed += 1;
      continue;
    }

    if (claim.kind === "terminal" && claim.status === "succeeded") {
      untouched.delete(member.id);
      await persist(input, member, "succeeded", null, member.attempt_count, clock());
      continue;
    }

    if (claim.kind === "terminal" && claim.status === "failed") {
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "failed_structural",
        null,
        member.attempt_count,
        clock(),
      );
      counts.failed += 1;
      continue;
    }

    // `reconciliation_required` is terminal for the ACTION and
    // unresolved for the MEMBER. A delete may have reached a real
    // person's relationship and its outcome is unknown, so this pass
    // may read truth and may never send anything.
    const reconcileOnly =
      claim.kind === "reconcile_only" || claim.kind === "terminal";

    let result: AttemptResult;
    switch (claim.kind) {
      case "may_mutate":
        result = await attemptUnfollow(input, member, claim.permit);
        break;
      case "reconcile_only":
      // Only `reconciliation_required` reaches here; the other two
      // terminal statuses returned above.
      case "terminal": {
        // The rejection the action already recorded decides whether
        // there is anything to reconcile at all — see the follow
        // worker's `reconcileOnly` for the incident this prevents.
        const recorded = await getCampaignActionRejection({
          workspaceId: input.campaign.workspace_id,
          actionId: claim.actionId,
          db: input.db,
        });
        result = reconcileFromObservation(observed, recorded?.errorCode ?? null);
        break;
      }
      default: {
        // A verdict added later cannot be silently ignored — which is
        // exactly how the follow subsystem sent a duplicate follow.
        const unreachable: never = claim;
        throw new Error(
          `unhandled unfollow verdict: ${JSON.stringify(unreachable)}`,
        );
      }
    }

    untouched.delete(member.id);
    rateLimit = result.rateLimit ?? rateLimit;

    // A reconciliation-only pass sends nothing, so it must not spend an
    // attempt or a unit of quota. Spending an attempt would eventually
    // exhaust MAX_MEMBER_ATTEMPTS and turn an UNRESOLVED member into a
    // structural failure reached without a single request being made.
    const attemptsAfter = reconcileOnly
      ? member.attempt_count
      : member.attempt_count + 1;

    const decision = classifyUnfollowOutcome({
      kind: result.kind,
      attemptCount: attemptsAfter,
      resumeAfter: result.resumeAfter,
    });

    // Refused before writing → re-open for a real retry rather than
    // file as reconciliation (the database refuses any code that does
    // not prove the refusal, in which case the filing below stands).
    let reopened = false;
    if (result.rejectedBeforeWrite && decision.memberStatus === "retryable") {
      const outcome = await reopenCampaignAction({
        workspaceId: input.campaign.workspace_id,
        actionId: claim.actionId,
        memberId: member.id,
        errorCode: result.reopenCode ?? "provider_rejected_before_write",
        errorMessage: result.errorMessage ?? null,
        db: input.db,
      });
      reopened = outcome.reopened;
    }

    if (!reopened) await completeCampaignAction({
      workspaceId: input.campaign.workspace_id,
      actionId: claim.actionId,
      status:
        decision.kind === "succeeded"
          ? "succeeded"
          : decision.kind === "already_not_following"
            ? "succeeded"
            : decision.memberStatus === "retryable"
              ? "reconciliation_required"
              : decision.memberStatus === "skipped" ||
                  decision.memberStatus === "protected"
                ? "skipped"
                : "failed",
      // The record this action targeted. On success it is the record
      // that was DELETED — which is how settlement tells "a record was
      // destroyed" from "there was nothing to destroy".
      followUri:
        decision.kind === "already_not_following" ? null : result.uri ?? null,
      followRkey: result.rkey ?? null,
      followCid: result.cid ?? null,
      providerErrorCode: result.errorCode ?? null,
      // Provider messages only. No token, no header, no credential
      // reaches a persisted column.
      providerErrorMessage: result.errorMessage ?? null,
      ...(result.reconciledState
        ? { reconciledState: result.reconciledState }
        : {}),
      ...(result.reconciliationNote
        ? { reconciliationNote: result.reconciliationNote }
        : {}),
      db: input.db,
    });

    // The slow lane for a reconciliation that learned nothing; the
    // ordinary retry backoff for a re-opened member, which is owed a
    // real attempt rather than another read.
    const reconcileBackoffMs =
      reconcileOnly && !reopened && decision.memberStatus === "retryable"
        ? reconciliationBackoffMs(
            await bumpReconcileCount({
              workspaceId: input.campaign.workspace_id,
              memberId: member.id,
              db: input.db,
            }),
          )
        : null;

    await persist(
      input,
      member,
      decision.memberStatus,
      result,
      attemptsAfter,
      clock(),
      reconcileBackoffMs,
    );

    if (!reconcileOnly) {
      counts.attempted += 1;
      if (decision.consumesQuota) counts.quotaConsumed += 1;
    }
    if (decision.kind === "succeeded") {
      counts.succeeded += 1;
      counts.recordsDeleted += 1;
    }
    if (decision.kind === "already_not_following") {
      counts.alreadyNotFollowing += 1;
    }
    if (decision.memberStatus === "skipped") counts.skipped += 1;
    if (decision.memberStatus === "protected") counts.protectedCount += 1;

    // A reconciliation that learned nothing is NOT a failure. Counting
    // it would trip the breaker on a campaign whose only problem is
    // that Bluesky's read index is behind its write log.
    if (decision.countsAsFailure && !reconcileOnly) {
      counts.failed += 1;
      consecutiveFailures += 1;
    } else if (decision.countsAsSuccess) {
      consecutiveFailures = 0;
    }

    if (decision.next.kind !== "continue") {
      next = decision.next;
      break;
    }

    if (consecutiveFailures >= input.campaign.max_consecutive_failures) {
      next = {
        kind: "stop_run",
        reason: `Stopped after ${consecutiveFailures} failures in a row.`,
      };
      break;
    }

    if (i < claimed.length - 1 && spacing > 0) await sleep(spacing);
  }

  // Hand back what we leased and never attempted — and ONLY what we
  // still hold.
  //
  // Releasing by id alone is unsafe for exactly the rows most likely to
  // be in this set: a lease can lapse while its worker is alive,
  // another worker reclaims the member and starts work, and this worker
  // then "returns" it — clearing the new owner's lease while a delete
  // for it may be in flight.
  if (untouched.size > 0) {
    await releaseOwnedMembers({
      workspaceId: input.campaign.workspace_id,
      campaignId: input.campaign.id,
      memberIds: [...untouched],
      claimedBy: input.claimedBy,
      reservationId: input.reservationId,
      db: input.db,
    });
  }

  return {
    ...counts,
    session: input.session,
    claimed: claimed.length,
    consecutiveFailures,
    next,
    rateLimit,
  };
}

interface AttemptResult {
  kind: UnfollowOutcomeKind;
  /** The provider refused before writing, or nothing was sent. See outcomes. */
  rejectedBeforeWrite?: boolean;
  reopenCode?: string | null;
  uri?: string | null;
  rkey?: string | null;
  cid?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resumeAfter?: Date | null;
  rateLimit?: RateLimitSnapshot | null;
  reconciledState?: string | null;
  reconciliationNote?: string | null;
}

/**
 * Reconciliation-only mode.
 *
 * Reached when a previous attempt may already have issued a delete — a
 * lease reclaimed after a crash, or a worker that lost the audit-row
 * race. **No mutation is sent from this path.** There is no call to
 * `deleteFollowRecord` in this function, and a test asserts zero
 * provider mutations in exactly this situation.
 *
 * It works from the observation the chunk already made, so it issues no
 * further request at all.
 *
 *   not following → the earlier delete landed, or there was never a
 *                   record. Either way the operator's intent holds.
 *   following     → the record is still there. That is NOT proof the
 *                   earlier delete failed: it may simply not have been
 *                   indexed yet, and re-sending against the CURRENT key
 *                   could remove a follow the operator has since
 *                   deliberately re-created. Recorded, not re-sent.
 *   unknown       → we still cannot tell. Nothing sent.
 */
function reconcileFromObservation(
  observed: LiveRelationship,
  recordedErrorCode: string | null,
): AttemptResult {
  if (observed.state === "not_following") {
    return {
      kind: "already_not_following",
      reconciledState: "not_following",
      reconciliationNote:
        "A previous attempt may have been sent before this worker took over. Bluesky reports this account is not followed, so nothing was re-sent.",
    };
  }
  // A recorded DEFINITE rejection (ExpiredToken, RateLimitExceeded)
  // proves the earlier delete was refused before any write. The record
  // is still there because nothing touched it — not because the read
  // index lags. Re-open for a real attempt instead of reading forever.
  if (isDefiniteRejectionCode(recordedErrorCode)) {
    const code = String(recordedErrorCode);
    return {
      kind: "retryable_transport_failure",
      errorCode: code,
      errorMessage: `Bluesky refused the earlier request before writing anything (${code}). Nothing to reconcile — this profile is owed a real retry.`,
      rejectedBeforeWrite: true,
      reopenCode: code,
      reconciliationNote: `The recorded provider error (${code}) proves the earlier request was refused before any write. Re-opened for a real attempt.`,
    };
  }
  if (observed.state === "following") {
    return {
      kind: "retryable_transport_failure",
      errorCode: "reconciliation_pending",
      errorMessage:
        "A previous unfollow for this profile may have reached Bluesky. Its outcome could not be confirmed, so NO further delete was sent.",
      reconciledState: "following",
      reconciliationNote:
        "Bluesky still reports this follow. That is not proof the earlier attempt failed — and re-sending could delete a follow you have since re-created — so nothing was re-sent.",
    };
  }
  return {
    kind: "retryable_transport_failure",
    errorCode: "reconciliation_pending",
    errorMessage:
      "A previous unfollow for this profile may have reached Bluesky, and the relationship could not be read either. Nothing was re-sent.",
    reconciliationNote: observed.reason,
  };
}

/**
 * One unfollow attempt.
 *
 * Dry-run short-circuits BEFORE the provider call — a dry run makes no
 * network request at all, which is the only honest meaning of the term.
 */
async function attemptUnfollow(
  input: ProcessChunkInput,
  member: ClaimedMember,
  /**
   * Proof that this record is this worker's to delete.
   *
   * A parameter rather than a checked boolean. The permit carries the
   * exact uri, rkey and cid the database approved, so this function has
   * no access to a key from anywhere else — there is no stored value in
   * scope it could reach for by mistake.
   */
  permit: UnfollowPermit,
): Promise<AttemptResult> {
  if (input.campaign.dry_run) {
    return {
      kind: "dry_run",
      uri: permit.uri,
      rkey: permit.rkey,
      errorCode: "dry_run",
      errorMessage:
        "Dry run: no follow record was deleted and no request was sent to Bluesky.",
    };
  }

  // SPEND THE UNIT FIRST.
  //
  // This is the last line before the provider, and it is where quota
  // stops being a promise and becomes a fact. It stamps
  // `provider_intent_at` on the ledger and `provider_in_flight_at` on
  // the action row IN ONE TRANSACTION, and the ledger stamp is never
  // cleared — so a process killed on the very next line still leaves
  // the day's books showing this attempt was made, and the next worker
  // knows a delete MAY have gone out.
  const unit = await consumeMemberQuota({
    workspaceId: input.campaign.workspace_id,
    campaignId: input.campaign.id,
    runId: input.runId,
    reservationId: input.reservationId,
    memberId: member.id,
    actionId: permit.actionId,
    operatorAccountId: input.campaign.operator_account_id,
    db: input.db,
  });

  if (!unit.mayMutate) {
    // The database declined to fund this attempt, so nothing is sent.
    // Retryable rather than terminal: the member did nothing wrong —
    // and nothing to reconcile, so the action is re-opened.
    return {
      kind: "retryable_transport_failure",
      errorCode: unit.refusedReason ?? "quota_unavailable",
      errorMessage:
        "The daily allowance for this account could not be reserved for this profile, so nothing was sent.",
      rejectedBeforeWrite: true,
      reopenCode: "provider_rejected_before_write",
    };
  }

  // THE PROVIDER CALL, WITH AT MOST ONE REFRESH.
  //
  // Everything that must happen once has already happened: the unit is
  // spent, the attempt counted, the ledger's intent stamped and the
  // action row marked in flight. The refresh and its single retry
  // therefore sit BELOW that line, inside one attempt — a second HTTP
  // request here consumes no second unit, creates no second action row
  // and stamps no second intent, because none of that code runs again.
  //
  // Bounded without counting: one conditional retry and no loop caps
  // the provider at two calls, and the session a refresh returns
  // refuses to refresh again, which caps renewals at one.
  const send = (session: RelationshipSession) =>
    deleteFollowRecord({
      accessJwt: session.accessJwt,
      actorDid: session.actorDid,
      rkey: permit.rkey,
      // Compare-and-swap against the exact record, when a CID is known.
      // The PDS then refuses if the record has been replaced since we
      // read it, which is a second, provider-side guard against
      // deleting something that is no longer what we looked at.
      swapCid: permit.cid,
      pds: session.service,
      fetchImpl: input.fetchImpl,
    });

  let result = await send(input.session);

  if (!result.ok && isRefreshableAuthFailure(result)) {
    const renewed = await input.session.refreshOnce();
    if (!renewed.ok) {
      // `refreshOnce` has already marked the connection expired. Stop
      // rather than spend a provider call per remaining member to be
      // told the same thing.
      return {
        kind: "authentication_expired",
        uri: permit.uri,
        rkey: permit.rkey,
        errorCode: "session_expired",
        errorMessage: renewed.message,
        rateLimit: result.rateLimit,
        // Refused at the door: nothing was deleted, a real retry is owed.
        rejectedBeforeWrite: true,
        reopenCode: "session_expired",
      };
    }
    // Adopted for every remaining member in this tick.
    input.session = renewed;
    result = await send(renewed);
  }

  if (result.ok) {
    return {
      kind: "succeeded",
      uri: permit.uri,
      rkey: permit.rkey,
      cid: permit.cid,
      rateLimit: result.rateLimit,
    };
  }

  const resumeAfter =
    result.rateLimit?.resetAt != null
      ? new Date(result.rateLimit.resetAt * 1000)
      : result.rateLimit?.retryAfterSeconds != null
        ? new Date(
            input.now.getTime() + result.rateLimit.retryAfterSeconds * 1000,
          )
        : null;

  const refused = rejectedBeforeWrite({ kind: result.kind, status: result.status });
  return {
    kind: outcomeFromGraphFailure({ kind: result.kind, status: result.status }),
    uri: permit.uri,
    rkey: permit.rkey,
    errorCode: result.errorCode,
    errorMessage: result.message,
    resumeAfter,
    rateLimit: result.rateLimit,
    rejectedBeforeWrite: refused,
    reopenCode: refused
      ? isDefiniteRejectionCode(result.errorCode)
        ? result.errorCode
        : result.kind === "rate_limited"
          ? "rate_limited"
          : result.kind === "auth"
            ? "session_expired"
            : "provider_rejected_before_write"
      : null,
  };
}

/** Persist one member's outcome. Always clears the lease. */
async function persist(
  input: ProcessChunkInput,
  member: ClaimedMember,
  status: string,
  result: AttemptResult | null,
  attemptCount: number,
  at: Date,
  /** Null → the ordinary retry backoff. A number → the reconciliation lane. */
  reconcileBackoffMs: number | null = null,
): Promise<void> {
  const nowIso = at.toISOString();
  const terminal = status !== "retryable";

  // A retry delay measured from when the observation FINISHED, not when
  // the tick began. An unresolved provider intent additionally waits
  // out the reconciliation backoff, so one ambiguous member cannot be
  // re-claimed over and over inside a single dispatcher pass while
  // healthy queued members wait behind it.
  const delayMs =
    reconcileBackoffMs ?? backoffDelayMs(Math.max(1, attemptCount));

  await updateMember({
    workspaceId: input.campaign.workspace_id,
    memberId: member.id,
    status: status as never,
    attemptCount: Math.max(attemptCount, member.attempt_count),
    // Cleared here and re-set below IN THE DATABASE'S CLOCK. Writing an
    // instant from the application's clock makes eligibility depend on
    // two clocks agreeing, and `reserve_bluesky_campaign_quota`
    // compares this against PostgreSQL's `now()`.
    nextAttemptAt: null,
    providerRecordUri: result?.uri ?? undefined,
    providerRecordRkey: result?.rkey ?? undefined,
    providerRecordCid: result?.cid ?? undefined,
    // A CLOSED reason on every terminal skip. The provider's own error
    // string ("InvalidRequest") says nothing an operator or the
    // conservation view can act on; the OUTCOME KIND ("actor_not_found")
    // is the reason. The provider's text is kept in the message.
    lastErrorCode:
      result && (status === "skipped" || status === "protected")
        ? terminalReasonCode(result.kind, result.errorCode)
        : result?.errorCode ?? null,
    lastErrorMessage: result?.errorMessage ?? null,
    lastAttemptedAt: attemptCount > 0 ? nowIso : undefined,
    completedAt: terminal ? nowIso : null,
    db: input.db,
  });

  if (status === "retryable") {
    await deferMember({
      workspaceId: input.campaign.workspace_id,
      memberId: member.id,
      delaySeconds: Math.ceil(delayMs / 1000),
      db: input.db,
    });
  }
}

export { MAX_MEMBER_ATTEMPTS };

/**
 * The closed set of reasons a member can be terminally skipped for.
 *
 * "No generic skipped status without a validated reason" — every
 * skipped or protected member carries one of these in `last_error_code`,
 * and `bluesky_campaign_conservation` categorises by it. A kind not in
 * the set falls back to the outcome kind itself, which is still a
 * closed vocabulary, never free text.
 */
export const TERMINAL_SKIP_REASONS = new Set([
  "actor_not_found",
  "ineligible",
  "protected",
  "conflict",
  "no_record_target",
  "dry_run",
  "blocked",
  "self",
  "invalid",
]);

function terminalReasonCode(kind: string, providerCode: string | null | undefined): string {
  if (TERMINAL_SKIP_REASONS.has(kind)) return kind;
  if (providerCode && TERMINAL_SKIP_REASONS.has(providerCode)) return providerCode;
  return kind;
}
