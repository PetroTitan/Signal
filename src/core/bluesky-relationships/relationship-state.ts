/**
 * Relationship truth — the mapping from what the provider said to what
 * Signal is willing to claim.
 *
 * Pure. No I/O, no dates read from a clock, no state.
 *
 * The whole module exists for one rule:
 *
 *   A failure to observe is not an observation of absence.
 *
 * `app.bsky.graph.getRelationships` signals "no edge" by OMITTING the
 * `following` key from an object it did return. That is a real
 * observation. But a DID missing from the response array, a
 * `#notFoundActor`, an HTTP 500, a 429 and a dropped connection are all
 * *non-observations*, and they are trivially easy to collapse into the
 * same falsy branch as "key absent" — `rel?.following ? "following" :
 * "not_following"` reads perfectly and is wrong in exactly the cases
 * that matter. Every function below forces the caller through a
 * `known` discriminant so that collapse cannot be written by accident.
 */

import type { BlueskyRelationshipState } from "@/lib/supabase/types";
import type { GraphFailure, RelationshipObservation } from "./atproto-graph";
import { rkeyFromAtUri } from "./atproto-graph";

export type { BlueskyRelationshipState };

/**
 * Relationship truth for one DID, as resolved from a provider answer.
 *
 * `followRecord` is populated only in the `following` and `mutual`
 * states, and only from the provider's own AT-URI.
 */
export interface ResolvedRelationship {
  did: string;
  state: BlueskyRelationshipState;
  /** Our follow record, when we follow them. */
  followRecord: { uri: string; rkey: string } | null;
  /**
   * Why the state is `unknown`, when it is. Null for every other state.
   * Surfaced to the operator so "unknown" never reads as a shrug.
   */
  unknownReason: string | null;
}

/**
 * Map ONE provider observation to a relationship state.
 *
 * The four states the provider can express:
 *
 *   following + followedBy   → mutual
 *   following only           → following
 *   followedBy only          → follows_you
 *   neither, but answered    → not_following   ← the only path to this
 *
 * and the one it cannot:
 *
 *   did not answer           → unknown
 */
export function resolveRelationship(
  observation: RelationshipObservation,
): ResolvedRelationship {
  if (!observation.known) {
    return {
      did: observation.did,
      state: "unknown",
      followRecord: null,
      unknownReason:
        observation.reason === "not_found_actor"
          ? "Bluesky could not resolve this account, so its relationship is unknown."
          : "Bluesky did not return a relationship for this account, so it is unknown.",
    };
  }

  const follows = observation.followingUri !== null;
  const followedBy = observation.followedByUri !== null;

  const state: BlueskyRelationshipState = follows
    ? followedBy
      ? "mutual"
      : "following"
    : followedBy
      ? "follows_you"
      : "not_following";

  let followRecord: ResolvedRelationship["followRecord"] = null;
  if (observation.followingUri) {
    const rkey = rkeyFromAtUri(observation.followingUri);
    // A `following` URI we cannot parse means we know the edge exists
    // but not how to remove it. The state is still `following` — that
    // much was observed — and the missing rkey is handled at unfollow
    // time by refusing rather than guessing.
    followRecord = rkey ? { uri: observation.followingUri, rkey } : null;
  }

  return { did: observation.did, state, followRecord, unknownReason: null };
}

/**
 * Map a whole-request FAILURE onto the DIDs it was asking about.
 *
 * Every DID becomes `unknown` with the provider's own reason. This
 * function is the ONLY way a failed lookup produces per-DID results, and
 * it cannot produce `not_following` — there is no branch that does.
 */
export function relationshipsUnavailable(
  dids: string[],
  failure: GraphFailure,
): ResolvedRelationship[] {
  const reason =
    failure.kind === "rate_limited"
      ? "Bluesky rate-limited the relationship lookup, so this is unknown — not confirmed as unfollowed."
      : failure.kind === "auth"
        ? "The Bluesky session was rejected during the relationship lookup, so this is unknown."
        : failure.kind === "network"
          ? "Bluesky could not be reached for the relationship lookup, so this is unknown."
          : `Bluesky did not answer the relationship lookup (${failure.message}), so this is unknown.`;

  return dids.map((did) => ({
    did,
    state: "unknown" as const,
    followRecord: null,
    unknownReason: reason,
  }));
}

/** Does this state mean the operator currently follows the account? */
export function isFollowing(state: BlueskyRelationshipState): boolean {
  return state === "following" || state === "mutual";
}

/** Does this state mean the account currently follows the operator? */
export function isFollowedBy(state: BlueskyRelationshipState): boolean {
  return state === "follows_you" || state === "mutual";
}

/** Operator-facing label. */
export function relationshipLabel(state: BlueskyRelationshipState): string {
  switch (state) {
    case "unknown":
      return "Unknown";
    case "not_following":
      return "Not following";
    case "following":
      return "Following";
    case "follows_you":
      return "Follows you";
    case "mutual":
      return "Mutual";
  }
}

/**
 * Chunk DIDs for `getRelationships`, whose `others` array is capped at
 * 30 (verified: 31 → HTTP 400 "array too big").
 */
export function chunkDids(dids: string[], size = 30): string[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const chunks: string[][] = [];
  for (let i = 0; i < dids.length; i += size) {
    chunks.push(dids.slice(i, i + size));
  }
  return chunks;
}
