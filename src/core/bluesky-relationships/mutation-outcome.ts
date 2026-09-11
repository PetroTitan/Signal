/**
 * Mutation outcomes and reconciliation — pure decision logic.
 *
 * No I/O. The caller performs the provider calls and the writes; this
 * module decides what each result MEANS and, critically, what is
 * allowed to happen next.
 *
 * THE RULE
 * --------
 *   unknown outcome → read provider relationship truth → reconcile →
 *   only then decide whether another mutation is appropriate.
 *
 * and the corollary that gives it teeth: **deciding is not doing**.
 * `classifyFollowOutcome` and `classifyUnfollowOutcome` have no branch
 * that returns "retry the mutation". The only values they can produce
 * for an ambiguous result route into reconciliation, and
 * `reconcileFollow` / `reconcileUnfollow` can only conclude
 * `succeeded`, or `reconciliation_required` with a note. Re-mutating is
 * a separate, operator-initiated action.
 *
 * WHY NOT JUST RETRY?
 * -------------------
 * `com.atproto.repo.createRecord` is not idempotent: every call mints a
 * fresh record key. A follow request that times out may well have
 * succeeded, and retrying it leaves TWO live follow records for one
 * account — one of which Signal has no record of and can therefore
 * never clean up. So an ambiguous follow is never retried.
 *
 * `deleteRecord` IS idempotent ("or ensure it doesn't exist"), so a
 * repeated unfollow is harmless in itself. It is still not retried
 * automatically, for a different reason: the danger of unfollow is
 * aiming at the wrong record, and an automatic loop that re-derives its
 * target is exactly how that happens. Both paths go through the same
 * operator gate, so there is one rule to reason about rather than two.
 *
 * WHY RECONCILIATION CANNOT CONCLUDE "RETRY IT"
 * --------------------------------------------
 * `getRelationships` is served by the AppView, which indexes the PDS
 * asynchronously. Just after a write, "not following" is ambiguous
 * between *the write failed* and *the AppView has not caught up*.
 * Nothing observable distinguishes them. Signal records what it saw and
 * stops; asserting either reading would be inventing a fact.
 */

import type {
  BlueskyActionStatus,
  BlueskyRelationshipState,
} from "@/lib/supabase/types";
import type {
  CreateFollowResult,
  DeleteFollowResult,
  GraphFailure,
} from "./atproto-graph";
import { isFollowing, type ResolvedRelationship } from "./relationship-state";

// =====================================================================
// Outcome classification
// =====================================================================

export type MutationOutcome =
  /** The provider confirmed it. */
  | {
      kind: "applied";
      followRecord: { uri: string; rkey: string; cid: string | null } | null;
    }
  /** Definitively refused, and re-issuing it would be refused again. */
  | {
      kind: "rejected";
      failure: GraphFailure;
    }
  /**
   * We do not know whether the provider applied it. MUST be followed by
   * a relationship read; MUST NOT be followed by a repeat of the
   * mutation.
   */
  | {
      kind: "ambiguous";
      failure: GraphFailure;
      reason: string;
    }
  /**
   * The provider is refusing work for now (rate limit) or the session is
   * dead (auth). Nothing was applied, the batch stops, progress is kept.
   */
  | {
      kind: "halt";
      failure: GraphFailure;
      resumable: boolean;
    };

/**
 * Which failures leave the provider's state genuinely unknown.
 *
 * A request that never reached Bluesky (DNS failure, connection
 * refused) did nothing. A request that was *sent* and then timed out or
 * died mid-flight may have been applied — the response is what we lost,
 * not necessarily the effect. This function is conservative in the
 * direction that avoids duplicates: anything that could have landed is
 * ambiguous.
 */
function isAmbiguousFailure(failure: GraphFailure): boolean {
  if (failure.kind === "network") {
    // status 0 covers both "never connected" and "connected, then lost".
    // They are not distinguishable from a fetch rejection, so the
    // safe reading — it might have landed — is the one taken.
    return true;
  }
  // 5xx: the PDS accepted the request and then failed somewhere. The
  // write may or may not have been committed before the failure.
  if (failure.status >= 500) return true;
  // A 2xx whose body we could not parse into a record URI. The write
  // almost certainly landed; we just cannot name the record.
  if (failure.status >= 200 && failure.status < 300) return true;
  return false;
}

export function classifyFollowOutcome(result: CreateFollowResult): MutationOutcome {
  if (result.ok) {
    return {
      kind: "applied",
      followRecord: {
        uri: result.record.uri,
        rkey: result.record.rkey,
        cid: result.record.cid,
      },
    };
  }

  if (result.kind === "rate_limited") {
    return { kind: "halt", failure: result, resumable: true };
  }
  if (result.kind === "auth") {
    return { kind: "halt", failure: result, resumable: false };
  }
  if (isAmbiguousFailure(result)) {
    return {
      kind: "ambiguous",
      failure: result,
      reason:
        "Bluesky did not confirm the follow. It may have been created. Signal will read the relationship rather than send a second follow, because creating a follow twice leaves two records for one account.",
    };
  }
  return { kind: "rejected", failure: result };
}

export function classifyUnfollowOutcome(
  result: DeleteFollowResult,
): MutationOutcome {
  if (result.ok) {
    return { kind: "applied", followRecord: null };
  }
  if (result.kind === "rate_limited") {
    return { kind: "halt", failure: result, resumable: true };
  }
  if (result.kind === "auth") {
    return { kind: "halt", failure: result, resumable: false };
  }
  if (isAmbiguousFailure(result)) {
    return {
      kind: "ambiguous",
      failure: result,
      reason:
        "Bluesky did not confirm the unfollow. Signal will read the relationship rather than send another delete.",
    };
  }
  return { kind: "rejected", failure: result };
}

// =====================================================================
// Reconciliation
// =====================================================================

export interface ReconciliationResult {
  /** The action's resulting status. Never 'pending' or 'running'. */
  status: Extract<
    BlueskyActionStatus,
    "succeeded" | "failed" | "reconciliation_required"
  >;
  /** What the relationship read observed. */
  observedState: BlueskyRelationshipState;
  /** Follow-record identity learned from the read, when there was one. */
  followRecord: { uri: string; rkey: string } | null;
  /** Operator-facing explanation. Always set. */
  note: string;
  /**
   * Whether issuing the mutation again would be a sensible OPERATOR
   * action. Advisory only — nothing in this subsystem acts on it
   * automatically, and no caller may treat it as permission to retry.
   */
  operatorMayReissue: boolean;
}

/**
 * Reconcile an ambiguous FOLLOW against the relationship the provider
 * reports.
 *
 * Three readings, no fourth:
 *
 *   following / mutual → the follow exists. Whether this attempt or an
 *                        earlier one created it does not matter; the
 *                        desired state holds. Succeeded, and the record
 *                        identity is captured so a future unfollow does
 *                        not have to guess.
 *
 *   unknown            → the read failed too. Still ambiguous. Nothing
 *                        is claimed and nothing is re-sent.
 *
 *   not_following /    → the follow is not visible. This is NOT proof
 *   follows_you          it failed: the AppView lags the PDS, so a
 *                        successful write can read back as absent for a
 *                        short window. Signal records the observation
 *                        and leaves the next move to the operator.
 */
export function reconcileFollow(
  resolved: ResolvedRelationship,
): ReconciliationResult {
  if (isFollowing(resolved.state)) {
    return {
      status: "succeeded",
      observedState: resolved.state,
      followRecord: resolved.followRecord,
      note: resolved.followRecord
        ? "Bluesky reports the follow exists; its record key was captured, so a later unfollow will not need to guess."
        : "Bluesky reports the follow exists, but returned no usable record URI for it. An unfollow will reconcile again before acting.",
      operatorMayReissue: false,
    };
  }

  if (resolved.state === "unknown") {
    return {
      status: "reconciliation_required",
      observedState: "unknown",
      followRecord: null,
      note:
        resolved.unknownReason ??
        "The follow could not be confirmed and the relationship could not be read. Nothing was re-sent.",
      // Unknown on top of unknown. Re-sending could duplicate a follow
      // that already exists.
      operatorMayReissue: false,
    };
  }

  return {
    status: "reconciliation_required",
    observedState: resolved.state,
    followRecord: null,
    note: "Bluesky does not currently report this follow. That is not proof the follow failed — Bluesky's read API indexes writes with a delay — so Signal has not sent it again. Retry it yourself if it is still missing.",
    operatorMayReissue: true,
  };
}

/**
 * Reconcile an ambiguous UNFOLLOW.
 *
 *   not_following /  → the follow is gone. Succeeded.
 *   follows_you
 *
 *   unknown          → still ambiguous.
 *
 *   following /      → the follow is still there. Again, indexing lag
 *   mutual             makes this inconclusive, so it is recorded, not
 *                      re-sent. The record key learned from the read is
 *                      kept, which is what makes a subsequent
 *                      operator-issued unfollow safe rather than a
 *                      guess.
 */
export function reconcileUnfollow(
  resolved: ResolvedRelationship,
): ReconciliationResult {
  if (resolved.state === "not_following" || resolved.state === "follows_you") {
    return {
      status: "succeeded",
      observedState: resolved.state,
      followRecord: null,
      note: "Bluesky reports the follow no longer exists.",
      operatorMayReissue: false,
    };
  }

  if (resolved.state === "unknown") {
    return {
      status: "reconciliation_required",
      observedState: "unknown",
      followRecord: null,
      note:
        resolved.unknownReason ??
        "The unfollow could not be confirmed and the relationship could not be read. Nothing was re-sent.",
      operatorMayReissue: false,
    };
  }

  return {
    status: "reconciliation_required",
    observedState: resolved.state,
    followRecord: resolved.followRecord,
    note: resolved.followRecord
      ? "Bluesky still reports this follow. Its record key has been recorded, so unfollowing again will target the right record. Signal did not re-send it on its own."
      : "Bluesky still reports this follow but returned no usable record URI, so there is nothing safe to delete yet.",
    operatorMayReissue: resolved.followRecord !== null,
  };
}

// =====================================================================
// Pre-flight: should this mutation even be attempted?
// =====================================================================

export type PreflightDecision =
  | { proceed: true }
  | { proceed: false; status: Extract<BlueskyActionStatus, "skipped" | "failed">; reason: string };

export interface FollowPreflightInput {
  subjectDid: string;
  actorDid: string;
  currentState: BlueskyRelationshipState;
}

/**
 * Decide whether a follow should be sent.
 *
 * Note that `unknown` PROCEEDS. Refusing to act on unknown would make
 * the module useless — most candidates are unknown until acted on — and
 * the duplicate-follow risk is carried by the database's one-active-
 * action index plus the already-exists reconciliation below, not by
 * guessing here.
 */
export function preflightFollow(input: FollowPreflightInput): PreflightDecision {
  if (!input.subjectDid.startsWith("did:")) {
    return {
      proceed: false,
      status: "failed",
      reason: "Subject is not a DID. A handle is never used as identity.",
    };
  }
  if (input.subjectDid === input.actorDid) {
    return {
      proceed: false,
      status: "skipped",
      reason: "An account cannot follow itself.",
    };
  }
  if (isFollowing(input.currentState)) {
    return {
      proceed: false,
      status: "skipped",
      reason:
        "Already following. Sending another follow would create a second follow record for the same account.",
    };
  }
  return { proceed: true };
}

export interface UnfollowPreflightInput {
  subjectDid: string;
  currentState: BlueskyRelationshipState;
  protectedRelationship: boolean;
  followRkey: string | null;
}

/**
 * Decide whether an unfollow should be sent.
 *
 * Two refusals matter:
 *
 *   protected → excluded unconditionally, and checked FIRST so that no
 *               other condition can order around it.
 *
 *   no rkey   → refused, because deleteRecord is idempotent and a
 *               plausible-but-wrong key would silently remove a
 *               different relationship and report success. The caller
 *               reconciles to learn the real key and tries again.
 */
export function preflightUnfollow(
  input: UnfollowPreflightInput,
): PreflightDecision {
  if (input.protectedRelationship) {
    return {
      proceed: false,
      status: "skipped",
      reason: "Protected. Protected relationships are never unfollowed.",
    };
  }
  if (!input.subjectDid.startsWith("did:")) {
    return {
      proceed: false,
      status: "failed",
      reason: "Subject is not a DID. A handle is never used as identity.",
    };
  }
  if (input.currentState === "not_following") {
    return {
      proceed: false,
      status: "skipped",
      reason: "Not currently following this account.",
    };
  }
  if (!input.followRkey) {
    return {
      proceed: false,
      status: "failed",
      reason:
        "No follow-record key is known, so there is nothing safe to delete. Reconcile against Bluesky first — a record key is never derived from the account's DID.",
    };
  }
  return { proceed: true };
}

/**
 * Bluesky's own "you already follow them" style rejections.
 *
 * Not currently emitted by createRecord (which happily creates a
 * duplicate instead), but a PDS is free to start enforcing it, and a
 * self-hosted PDS may already. Recognising it routes the caller into
 * reconciliation — learn the existing record's identity — rather than
 * recording a failure for a relationship that is in the desired state.
 */
export function looksLikeAlreadyExists(failure: GraphFailure): boolean {
  const code = (failure.errorCode ?? "").toLowerCase();
  const message = failure.message.toLowerCase();
  return (
    code === "recordalreadyexists" ||
    code === "invalidrecordkey" ||
    message.includes("already exists") ||
    message.includes("already following")
  );
}
