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
  isRefreshableAuthFailure,
  getRelationships,
  type RateLimitSnapshot,
} from "@/core/bluesky-relationships/atproto-graph";
import { resolveRelationship } from "@/core/bluesky-relationships/relationship-state";
import { INTER_REQUEST_MS } from "@/core/bluesky-relationships/execute-actions.server";
import { MAX_RELATIONSHIP_BATCH_SIZE } from "@/core/bluesky-relationships/limits";
import type { RelationshipSession } from "@/core/bluesky-relationships/session.server";
import type { MutationPermit } from "@/repositories/bluesky-campaign-repository";
import {
  claimCampaignAction,
  consumeMemberQuota,
  completeCampaignAction,
  releaseOwnedMembers,
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

/**
 * How long one dispatcher may hold a campaign-day.
 *
 * Bounded by the platform's own function limit (`maxDuration = 300`) so
 * a killed dispatcher's campaign becomes available again on roughly the
 * next cron tick, plus a margin for the settlement writes that follow
 * the last chunk.
 */
export const DISPATCH_LEASE_SECONDS = 360;

/**
 * An unresolved provider intent is read-only work, but it is deliberately
 * kept out of the same dispatcher pass for long enough that slow settlement
 * cannot make it eligible again before untouched queue members are claimed.
 */
export const RECONCILIATION_BACKOFF_MS = 10 * 60_000;

export interface ChunkOutcomeCounts {
  /**
   * Members another worker owned, which this one left alone.
   *
   * Not a failure and not an attempt: nothing was sent, nothing was
   * spent, and the member is someone else's to finish.
   */
  denied: number;
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
  denied: 0,
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
  /**
   * The reservation that paid for these members.
   *
   * Quoted back to the database before every provider mutation, to
   * convert one of its reserved units into a durable attempted one.
   */
  reservationId: string;
  /** Quota units still available. Bounds the claim. */
  quotaRemaining: number;
  /** Consecutive failures carried in from earlier chunks in this run. */
  consecutiveFailures: number;
  /** Worker identity, for lease attribution. */
  claimedBy: string;
  /** Who started the campaign, for the audit row. */
  initiatedBy?: string | null;
  /**
   * The instant this tick is working from.
   *
   * Passed in rather than read here so every timestamp the chunk writes
   * agrees with the rest of the pass. Reading the wall clock made a
   * retry backoff land relative to a different "now" than the
   * dispatcher's, which is invisible in production and makes a test
   * measure the hour it was run at.
   */
  now: Date;
  /**
   * Wall clock after provider I/O. A retry delay starts when the
   * observation finishes, not when the enclosing tick began.
   */
  currentTime?: () => Date;
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

    // ── The verdict is a closed set, and every branch is handled. ──
    //
    // It used to be three independent booleans, and the worker read
    // only two of them. The combination the RPC returns when this
    // worker LOST the race to create the audit row — not terminal,
    // nothing to reconcile, not ours — looked like "nothing special"
    // and fell straight through to the mutation path. The losing worker
    // sent a second follow for a member another worker owned, and spent
    // a unit of quota doing it.
    if (claim.kind === "denied") {
      // This member is not ours. Not terminal, and NOT reconciliation:
      // no provider intent exists for this worker and nothing has been
      // sent on its behalf, so claiming otherwise would put a fiction
      // in the operator's History.
      //
      // Nothing is persisted, nothing is counted, and the audit row —
      // which belongs to the winner — is not touched.
      //
      // The member is NOT handed back either. Releasing it would put it
      // straight back in the queue, where this same pass would reserve
      // it again and be denied again; the first version of this fix
      // spun on exactly that. And a member someone else is working on
      // is not ours to return. The lease we hold lapses on its own,
      // by which time the winner has finished it or died and left it
      // genuinely recoverable.
      untouched.delete(member.id);
      counts.denied += 1;
      continue;
    }

    if (claim.kind === "terminal" && claim.status === "succeeded") {
      // Confirmed by a previous pass. Not an attempt, no quota.
      untouched.delete(member.id);
      await persist(input, member, "succeeded", null, member.attempt_count);
      continue;
    }

    if (claim.kind === "terminal" && claim.status === "failed") {
      // A previous pass established this cannot succeed. Terminal, but
      // terminal-failed — never reported as a follow.
      untouched.delete(member.id);
      await persist(
        input,
        member,
        "failed_structural",
        null,
        member.attempt_count,
      );
      counts.failed += 1;
      continue;
    }

    // `reconciliation_required` is terminal for the ACTION and
    // unresolved for the MEMBER. The outcome of a possible provider
    // mutation is unknown, so this pass may read relationship truth and
    // may never send anything. It resolves only when Bluesky confirms
    // the follow; until then the member stays retryable and the action
    // stays reconciliation_required, however many passes go by.
    const reconcileOnlyClaim =
      claim.kind === "reconcile_only" || claim.kind === "terminal";

    if (known === "following") {
      // Observed, not assumed. No record is created and no quota is
      // consumed — the requirement is explicit about this. The audit
      // row is still finalised, which is what clears an in-flight
      // marker left by a worker that died mid-mutation.
      await completeCampaignAction({
        workspaceId: input.campaign.workspace_id,
        actionId: claim.actionId,
        status: "succeeded",
        reconciliationNote: reconcileOnlyClaim
          ? "A previous attempt may have been sent before this worker took over. Bluesky reports the follow exists, so nothing was re-sent."
          : "Already following before this campaign reached them. No follow record was created and no quota was consumed.",
        db: input.db,
      });
      await persist(input, member, "already_following", null, 0);
      untouched.delete(member.id);
      counts.alreadyFollowing += 1;
      continue;
    }

    // Reaching the provider requires the PERMIT, which only the
    // `may_mutate` verdict carries. There is no boolean to forget to
    // read: a branch that has not established permission cannot call
    // `attemptFollow` at all, and the `never` below means a verdict
    // added later cannot be silently ignored the way `may_mutate` was.
    let result: AttemptResult;
    switch (claim.kind) {
      case "may_mutate":
        result = await attemptFollow(input, member, claim.permit);
        break;
      case "reconcile_only":
      // Only `reconciliation_required` reaches here; the other two
      // terminal statuses returned above.
      case "terminal":
        // RECONCILIATION-ONLY MODE. No mutation may be sent while a
        // prior attempt's outcome is unknown.
        result = await reconcileOnly(input, member, claim.actionId);
        break;
      default: {
        const unreachable: never = claim;
        throw new Error(
          `unhandled claim verdict: ${JSON.stringify(unreachable)}`,
        );
      }
    }

    untouched.delete(member.id);
    rateLimit = result.rateLimit ?? rateLimit;

    // A reconciliation-only pass sends nothing, so it must not spend an
    // attempt or a unit of quota.
    //
    // Spending an attempt would eventually exhaust MAX_MEMBER_ATTEMPTS
    // and turn an UNRESOLVED member into `failed_structural` — a false
    // terminal state reached without a single request being made. And
    // counting it as attempted would shrink the day's quota to pay for
    // reads that never touched the provider.
    const attemptsAfter = reconcileOnlyClaim
      ? member.attempt_count
      : member.attempt_count + 1;

    const decision = classifyOutcome({
      kind: result.kind,
      attemptCount: attemptsAfter,
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
      attemptsAfter,
      reconcileOnlyClaim ? RECONCILIATION_BACKOFF_MS : 0,
    );

    if (!reconcileOnlyClaim) {
      counts.attempted += 1;
      if (decision.consumesQuota) counts.quotaConsumed += 1;
    }
    if (decision.kind === "succeeded") {
      counts.succeeded += 1;
      counts.recordsCreated += 1;
    }
    if (decision.memberStatus === "skipped" || decision.memberStatus === "protected") {
      counts.skipped += 1;
    }
    // Reconciliation is a read-only observation of an attempt whose
    // outcome is still unknown. It is neither a new failure nor a new
    // success, so it must leave the provider-failure breaker untouched.
    // Counting it here let one old ambiguous action eventually pause a
    // healthy 20,000-member campaign even though this worker had sent
    // zero requests and consumed zero quota.
    if (!reconcileOnlyClaim) {
      if (decision.countsAsFailure) {
        counts.failed += 1;
        consecutiveFailures += 1;
      } else if (decision.countsAsSuccess) {
        consecutiveFailures = 0;
      }
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

  // Hand back what we leased and never attempted — and ONLY what we
  // still hold.
  //
  // Releasing by id alone was unsafe for exactly the rows most likely
  // to be in this set. A lease lapses while its worker is still alive,
  // another worker reclaims the member and starts work, and this worker
  // then "returns" it — clearing the new owner's lease while a request
  // for it may be in flight. The same helper is what a worker reaches
  // for after being told a member is not its to work on, which is the
  // moment that member is most likely to belong to someone else.
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
  /**
   * Proof that the audit row is this worker's to act on.
   *
   * A parameter rather than a checked boolean: the verdict used to be
   * three booleans and the worker read two of them, so "this member is
   * not yours" reached this function and a duplicate follow went out.
   * Now only the verdict that grants permission can produce one of
   * these, so there is nothing left to forget.
   */
  permit: MutationPermit,
): Promise<AttemptResult> {
  const actionId = permit.actionId;
  if (input.campaign.dry_run) {
    return {
      kind: "dry_run",
      errorCode: "dry_run",
      errorMessage:
        "Dry run: no follow was created and no request was sent to Bluesky.",
    };
  }

  // SPEND THE UNIT FIRST.
  //
  // This is the last line before the provider, and it is where quota
  // stops being a promise and becomes a fact. The stamp it writes is
  // never cleared, so a process killed on the next line still leaves
  // the day's books showing that this attempt was made.
  //
  // Reporting attempts in bulk at settlement is what made that
  // impossible: a worker that died after following four people left
  // those four recorded nowhere, and the sweep handed their quota back.
  const unit = await consumeMemberQuota({
    workspaceId: input.campaign.workspace_id,
    campaignId: input.campaign.id,
    runId: input.runId,
    reservationId: input.reservationId,
    memberId: member.id,
    actionId,
    operatorAccountId: input.campaign.operator_account_id,
    db: input.db,
  });

  if (!unit.mayMutate) {
    // The database declined to fund this attempt, so no request is
    // sent. Retryable rather than terminal: the member did nothing
    // wrong and the next tick will reserve for it properly.
    return {
      kind: "retryable_transport_failure",
      errorCode: unit.refusedReason ?? "quota_unavailable",
      errorMessage:
        "The daily allowance for this identity could not be reserved for this profile, so no follow was sent.",
    };
  }

  // THE PROVIDER CALL, WITH AT MOST ONE REFRESH.
  //
  // Everything that must happen once has already happened: the unit is
  // spent, the attempt counted, the ledger's provider intent stamped
  // and the audit row marked in flight. The refresh and the single
  // retry therefore sit BELOW that line, inside one attempt — a second
  // HTTP request here consumes no second unit, creates no second action
  // row and stamps no second intent, because none of that code runs
  // again.
  //
  // Bounded without counting: one conditional retry and no loop caps
  // the provider at two calls, and the session a refresh returns
  // refuses to refresh again, which caps renewals at one.
  const send = (session: RelationshipSession) =>
    createFollowRecord({
      accessJwt: session.accessJwt,
      actorDid: session.actorDid,
      subjectDid: member.subject_did,
      pds: session.service,
      fetchImpl: input.fetchImpl,
    });

  let result = await send(input.session);

  if (!result.ok && isRefreshableAuthFailure(result)) {
    const renewed = await input.session.refreshOnce();
    if (!renewed.ok) {
      // `refreshOnce` has already marked the connection expired. Stop
      // the campaign rather than spend a provider call per remaining
      // member to be told the same thing.
      return {
        kind: "authentication_expired",
        errorCode: "session_expired",
        errorMessage: renewed.message,
        rateLimit: result.rateLimit,
      };
    }
    // Adopted for every remaining member in this tick. `input.session`
    // is the chunk's own object, so the rest of the loop picks it up
    // with nothing to thread through.
    input.session = renewed;
    result = await send(renewed);
  }

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
        ? new Date(input.now.getTime() + result.rateLimit.retryAfterSeconds * 1000)
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
  minimumBackoffMs = 0,
): Promise<void> {
  const now = input.now.toISOString();
  const retryBase = input.currentTime?.() ?? input.now;
  const terminal = status !== "retryable";

  await updateMember({
    workspaceId: input.campaign.workspace_id,
    memberId: member.id,
    status: status as never,
    attemptCount: Math.max(attemptCount, member.attempt_count),
    nextAttemptAt:
      status === "retryable"
        ? new Date(
            retryBase.getTime() +
              Math.max(
                backoffDelayMs(Math.max(1, attemptCount)),
                minimumBackoffMs,
              ),
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
