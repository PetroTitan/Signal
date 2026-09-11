import "server-only";
/**
 * The campaign worker: process one bounded chunk of a daily run.
 *
 * This is the only code in the campaign system that creates a follow
 * record, and it does so through the SAME provider client and the SAME
 * spacing the manual workflow uses. Nothing about the manual path is
 * changed, weakened, or bypassed.
 *
 * WHAT A CHUNK IS
 * ---------------
 * At most `MAX_RELATIONSHIP_BATCH_SIZE` members — the existing manual
 * limit, unchanged. That constant was chosen by arithmetic against a
 * 60-second budget; the cron route has a larger budget, so a tick runs
 * SEVERAL chunks rather than one bigger one. Raising the chunk size
 * would silently re-tune a number that was justified elsewhere.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 *   - It never unfollows. There is no delete path in this file, and a
 *     test asserts the absence.
 *   - It never retries a mutation whose outcome it could not read.
 *     `createRecord` is not idempotent, so an ambiguous result reads
 *     relationship truth instead — the reconciliation model the manual
 *     path already uses.
 *   - It never widens the run. The members it processes are the ones
 *     the claiming RPC leased; it cannot ask for different ones.
 *   - It adds no jitter to request spacing. The fixed
 *     `INTER_REQUEST_MS` is the same courtesy interval the manual path
 *     uses, and randomising it would be disguising traffic rather than
 *     pacing it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFollowRecord,
  getRelationships,
  type RateLimitSnapshot,
} from "@/core/bluesky-relationships/atproto-graph";
import { resolveRelationship } from "@/core/bluesky-relationships/relationship-state";
import { INTER_REQUEST_MS } from "@/core/bluesky-relationships/execute-actions.server";
import { MAX_RELATIONSHIP_BATCH_SIZE } from "@/core/bluesky-relationships/limits";
import type { RelationshipSession } from "@/core/bluesky-relationships/session.server";
import {
  claimCampaignAction,
  completeCampaignAction,
  releaseMembers,
  updateMember,
  type ClaimedMember,
} from "@/repositories/bluesky-campaign-repository";
import type { BlueskyFollowCampaignRow } from "@/lib/supabase/types";
import {
  backoffDelayMs,
  classifyOutcome,
  MAX_MEMBER_ATTEMPTS,
  outcomeFromGraphFailure,
  type CampaignOutcomeKind,
  type NextAction,
} from "./outcomes";

/** Chunk size. Deliberately the existing manual maximum. */
export const CAMPAIGN_CHUNK_SIZE = MAX_RELATIONSHIP_BATCH_SIZE;

/**
 * Lease length.
 *
 * Long enough that a chunk cannot outlive its own lease — 20 members at
 * ~1.8s each is ~36s, so 5 minutes leaves a wide margin — and short
 * enough that a worker killed mid-chunk returns its rows to the queue
 * within one cron interval rather than stranding them for an hour.
 */
export const LEASE_SECONDS = 300;

export interface ChunkOutcomeCounts {
  attempted: number;
  succeeded: number;
  alreadyFollowing: number;
  skipped: number;
  failed: number;
  /** Quota units consumed. NOT the same as `attempted`. */
  quotaConsumed: number;
  /** Follow records actually created — what the provider counts. */
  recordsCreated: number;
}

export interface ChunkResult extends ChunkOutcomeCounts {
  /** Members leased this chunk. */
  claimed: number;
  /** Consecutive failures at the end of the chunk. */
  consecutiveFailures: number;
  /** What the caller should do next. */
  next: NextAction;
  rateLimit: RateLimitSnapshot | null;
}

const emptyCounts = (): ChunkOutcomeCounts => ({
  attempted: 0,
  succeeded: 0,
  alreadyFollowing: 0,
  skipped: 0,
  failed: 0,
  quotaConsumed: 0,
  recordsCreated: 0,
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
   * work could claim more than was reserved, which is the hole that
   * let two dispatchers exceed the daily quota.
   */
  members: ClaimedMember[];
  /** Quota units still available. Bounds the claim. */
  quotaRemaining: number;
  /** Consecutive failures carried in from earlier chunks in this run. */
  consecutiveFailures: number;
  /** Worker identity, for lease attribution. */
  claimedBy: string;
  /** Who started the campaign, for the audit row. */
  initiatedBy?: string | null;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  interRequestMs?: number;
}

/**
 * Read the current relationship for a batch of DIDs.
 *
 * Done BEFORE mutating so an account already followed is not followed
 * again — `already_following` costs no quota, which is the requirement,
 * and it also means a re-run of a partially-completed campaign is
 * cheap rather than duplicative.
 *
 * Reads go to the public AppView, which is a different host from the
 * PDS and does not consume the account's write budget.
 */
async function readRelationships(
  input: ProcessChunkInput,
  dids: string[],
): Promise<Map<string, "following" | "not_following" | "unknown">> {
  const out = new Map<string, "following" | "not_following" | "unknown">();
  if (dids.length === 0) return out;

  const result = await getRelationships({
    actor: input.session.actorDid,
    others: dids,
    appView: input.appView,
    fetchImpl: input.fetchImpl,
  });

  if (!result.ok) {
    // A failed lookup is UNKNOWN for every DID — never "not following".
    // Proceeding to follow on unknown is correct here (the provider
    // will tell us if it already exists); recording it as
    // "not_following" would be asserting an absence nobody observed.
    for (const did of dids) out.set(did, "unknown");
    return out;
  }

  for (const did of dids) {
    const observation = result.observations.get(did);
    if (!observation) {
      out.set(did, "unknown");
      continue;
    }
    const resolved = resolveRelationship(observation);
    out.set(
      did,
      resolved.state === "following" || resolved.state === "mutual"
        ? "following"
        : resolved.state === "unknown"
          ? "unknown"
          : "not_following",
    );
  }
  return out;
}

/**
 * Process one chunk.
 *
 * Claims atomically, processes sequentially with the standard spacing,
 * persists every outcome as it happens, and releases anything it did
 * not touch. Returns what the dispatcher needs to decide whether to run
 * another chunk.
 */
export async function processCampaignChunk(
  input: ProcessChunkInput,
): Promise<ChunkResult> {
  const counts = emptyCounts();
  let consecutiveFailures = input.consecutiveFailures;
  let next: NextAction = { kind: "continue" };
  let rateLimit: RateLimitSnapshot | null = null;

  const claimed = input.members;
  if (claimed.length === 0) {
    return { ...counts, claimed: 0, consecutiveFailures, next, rateLimit };
  }

  // Everything leased but not yet resolved. Anything left here at the
  // end goes back to the queue WITHOUT consuming an attempt.
  const untouched = new Set(claimed.map((m) => m.id));

  const relationships = await readRelationships(
    input,
    claimed.map((m) => m.subject_did),
  );

  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const spacing = input.interRequestMs ?? INTER_REQUEST_MS;

  for (let i = 0; i < claimed.length; i += 1) {
    const member = claimed[i];

    // Quota is re-checked per member, not only per chunk: a chunk of 20
    // with 3 units left must attempt 3.
    if (counts.quotaConsumed >= input.quotaRemaining) break;

    const known = relationships.get(member.subject_did) ?? "unknown";

    // ── The audit row comes BEFORE anything else. ───────────────────
    //
    // Claimed even on the already-following path, which is not merely
    // tidiness: a worker killed mid-mutation leaves an action row
    // marked in-flight, and if the next pass short-circuits on
    // "already following" without touching it, that row stays `running`
    // with its in-flight marker forever — the member looks finished
    // while History says a request is still outstanding.
    //
    // It is both the History entry and the crash-safety record. A row
    // already marked in-flight means a previous worker MAY have issued
    // a createRecord before dying; createRecord is not idempotent, so
    // the only safe move is to read relationship truth. Sending again
    // would leave two follow records with Signal tracking one.
    const claim = await claimCampaignAction({
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

    if (claim.terminal) {
      // Someone already finished this member. Not an attempt, no quota.
      untouched.delete(member.id);
      await persist(input, member, "succeeded", null, member.attempt_count);
      continue;
    }

    if (known === "following") {
      // Observed, not assumed. No record is created and no quota is
      // consumed — the requirement is explicit about this. The audit
      // row is still finalised, which is what clears an in-flight
      // marker left by a worker that died mid-mutation.
      await completeCampaignAction({
        workspaceId: input.campaign.workspace_id,
        actionId: claim.actionId,
        status: "succeeded",
        reconciliationNote: claim.needsReconcile
          ? "A previous attempt may have been sent before this worker took over. Bluesky reports the follow exists, so nothing was re-sent."
          : "Already following before this campaign reached them. No follow record was created and no quota was consumed.",
        db: input.db,
      });
      await persist(input, member, "already_following", null, 0);
      untouched.delete(member.id);
      counts.alreadyFollowing += 1;
      continue;
    }

    const result = claim.needsReconcile
      ? // RECONCILIATION-ONLY MODE. No mutation may be sent while a
        // prior attempt's outcome is unknown.
        await reconcileOnly(input, member, claim.actionId)
      : await attemptFollow(input, member, claim.actionId);

    untouched.delete(member.id);
    rateLimit = result.rateLimit ?? rateLimit;

    const decision = classifyOutcome({
      kind: result.kind,
      attemptCount: member.attempt_count + 1,
      resumeAfter: result.resumeAfter,
    });

    await completeCampaignAction({
      workspaceId: input.campaign.workspace_id,
      actionId: claim.actionId,
      status:
        decision.kind === "succeeded"
          ? "succeeded"
          : decision.kind === "already_following"
            ? "succeeded"
            : decision.memberStatus === "retryable"
              ? "reconciliation_required"
              : decision.memberStatus === "skipped" ||
                  decision.memberStatus === "protected"
                ? "skipped"
                : "failed",
      followUri: result.uri ?? null,
      followRkey: result.rkey ?? null,
      followCid: result.cid ?? null,
      providerErrorCode: result.errorCode ?? null,
      providerErrorMessage: result.errorMessage ?? null,
      ...(result.reconciliationNote
        ? { reconciliationNote: result.reconciliationNote }
        : {}),
      db: input.db,
    });

    await persist(
      input,
      member,
      decision.memberStatus,
      result,
      member.attempt_count + 1,
    );

    counts.attempted += 1;
    if (decision.consumesQuota) counts.quotaConsumed += 1;
    if (decision.kind === "succeeded") {
      counts.succeeded += 1;
      counts.recordsCreated += 1;
    }
    if (decision.memberStatus === "skipped" || decision.memberStatus === "protected") {
      counts.skipped += 1;
    }
    if (decision.countsAsFailure) {
      counts.failed += 1;
      consecutiveFailures += 1;
    } else if (decision.countsAsSuccess) {
      consecutiveFailures = 0;
    }

    if (decision.next.kind !== "continue") {
      next = decision.next;
      break;
    }

    // Circuit breaker inside the chunk, so a run that starts failing
    // stops within one chunk rather than after twenty.
    if (consecutiveFailures >= input.campaign.max_consecutive_failures) {
      next = {
        kind: "stop_run",
        reason: `Stopped after ${consecutiveFailures} consecutive failures.`,
      };
      break;
    }

    if (i < claimed.length - 1 && spacing > 0) await sleep(spacing);
  }

  // Return everything we leased but never attempted.
  if (untouched.size > 0) {
    await releaseMembers({
      workspaceId: input.campaign.workspace_id,
      campaignId: input.campaign.id,
      memberIds: [...untouched],
      db: input.db,
    });
  }

  return {
    ...counts,
    claimed: claimed.length,
    consecutiveFailures,
    next,
    rateLimit,
  };
}

interface AttemptResult {
  kind: CampaignOutcomeKind;
  uri?: string | null;
  rkey?: string | null;
  cid?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resumeAfter?: Date | null;
  rateLimit?: RateLimitSnapshot | null;
  reconciliationNote?: string | null;
}

/**
 * Reconciliation-only mode.
 *
 * Reached when a previous attempt may already have issued a
 * createRecord — a lease reclaimed after a crash, or a concurrent
 * worker that won the audit-row race. **No mutation is sent from this
 * path.** There is no call to createFollowRecord in this function, and
 * a test asserts the worker performs zero additional Follow mutations
 * in exactly this situation.
 *
 * Three readings:
 *   following  → the earlier attempt landed. Succeeded.
 *   unknown    → we still cannot tell. Stays retryable; nothing sent.
 *   otherwise  → not visible yet. Bluesky's read API indexes writes
 *                with a delay, so "not there" is NOT proof it failed.
 *                Recorded, not re-sent.
 */
async function reconcileOnly(
  input: ProcessChunkInput,
  member: ClaimedMember,
  _actionId: string,
): Promise<AttemptResult> {
  const truth = await readRelationships(input, [member.subject_did]);
  const state = truth.get(member.subject_did) ?? "unknown";

  if (state === "following") {
    return {
      kind: "already_following",
      reconciliationNote:
        "A previous attempt may have been sent before this worker took over. Bluesky reports the follow exists, so nothing was re-sent.",
    };
  }
  return {
    kind: "retryable_transport_failure",
    errorCode: "reconciliation_pending",
    errorMessage:
      "A previous attempt for this profile may have reached Bluesky. Its outcome could not be confirmed, so NO further follow was sent.",
    reconciliationNote:
      state === "unknown"
        ? "The relationship could not be read either, so the outcome remains unknown. Nothing was re-sent."
        : "Bluesky does not currently report this follow. That is not proof it failed — Bluesky's read API indexes writes with a delay — so nothing was re-sent.",
  };
}

/**
 * One follow attempt.
 *
 * Dry-run short-circuits BEFORE the provider call — a dry run makes no
 * network request at all, which is the only honest meaning of the term.
 */
async function attemptFollow(
  input: ProcessChunkInput,
  member: ClaimedMember,
  _actionId: string,
): Promise<AttemptResult> {
  if (input.campaign.dry_run) {
    return {
      kind: "dry_run",
      errorCode: "dry_run",
      errorMessage:
        "Dry run: no follow was created and no request was sent to Bluesky.",
    };
  }

  const result = await createFollowRecord({
    accessJwt: input.session.accessJwt,
    actorDid: input.session.actorDid,
    subjectDid: member.subject_did,
    pds: input.session.service,
    fetchImpl: input.fetchImpl,
  });

  if (result.ok) {
    return {
      kind: "succeeded",
      uri: result.record.uri,
      rkey: result.record.rkey,
      cid: result.record.cid,
      rateLimit: result.rateLimit,
    };
  }

  // A 2xx we could not parse into a record URI is ambiguous: the record
  // may well exist. Reconcile rather than retry — createRecord mints a
  // new rkey per call, so a blind retry would leave two follow records
  // for one account and Signal would have a row for only one.
  if (result.status >= 200 && result.status < 300) {
    const truth = await readRelationships(input, [member.subject_did]);
    return truth.get(member.subject_did) === "following"
      ? { kind: "already_following", rateLimit: result.rateLimit }
      : {
          kind: "retryable_transport_failure",
          errorCode: "ambiguous_create",
          errorMessage:
            "Bluesky accepted the follow but returned no usable record URI, and the relationship could not be confirmed. It was NOT re-sent.",
          rateLimit: result.rateLimit,
        };
  }

  const resumeAfter =
    result.rateLimit?.resetAt != null
      ? new Date(result.rateLimit.resetAt * 1000)
      : result.rateLimit?.retryAfterSeconds != null
        ? new Date(Date.now() + result.rateLimit.retryAfterSeconds * 1000)
        : null;

  return {
    kind: outcomeFromGraphFailure({ kind: result.kind, status: result.status }),
    errorCode: result.errorCode,
    // Provider messages only. No token, no header, no credential ever
    // reaches a persisted column.
    errorMessage: result.message,
    resumeAfter,
    rateLimit: result.rateLimit,
  };
}

/** Persist one member's outcome. Always clears the lease. */
async function persist(
  input: ProcessChunkInput,
  member: ClaimedMember,
  status: string,
  result: AttemptResult | null,
  attemptCount: number,
): Promise<void> {
  const now = new Date().toISOString();
  const terminal = status !== "retryable";

  await updateMember({
    workspaceId: input.campaign.workspace_id,
    memberId: member.id,
    status: status as never,
    attemptCount: Math.max(attemptCount, member.attempt_count),
    nextAttemptAt:
      status === "retryable"
        ? new Date(
            Date.now() + backoffDelayMs(Math.max(1, attemptCount)),
          ).toISOString()
        : null,
    providerRecordUri: result?.uri ?? undefined,
    providerRecordRkey: result?.rkey ?? undefined,
    providerRecordCid: result?.cid ?? undefined,
    lastErrorCode: result?.errorCode ?? null,
    lastErrorMessage: result?.errorMessage ?? null,
    lastAttemptedAt: attemptCount > 0 ? now : undefined,
    completedAt: terminal ? now : null,
    db: input.db,
  });
}

export { MAX_MEMBER_ATTEMPTS };
