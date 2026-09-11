import "server-only";
/**
 * Refresh what Signal believes about a set of relationships.
 *
 * Reads `app.bsky.graph.getRelationships` in 30-DID chunks (the
 * provider's cap) and writes the result onto the candidates.
 *
 * The single property that matters: a chunk whose lookup FAILED writes
 * `unknown` plus the failure reason for every DID in it. There is no
 * path from a failed read to `not_following`, here or in the pure layer
 * this calls. That is what stops a provider outage from being recorded
 * as "we checked, and you follow nobody" — which would then make a
 * subsequent batch unfollow a no-op and a subsequent batch follow a
 * source of duplicate follow records.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getRelationships } from "./atproto-graph";
import {
  chunkDids,
  relationshipsUnavailable,
  resolveRelationship,
  type ResolvedRelationship,
} from "./relationship-state";
import { updateCandidateRelationship } from "@/repositories/bluesky-relationship-repository";
import { GET_RELATIONSHIPS_MAX_OTHERS } from "./atproto-graph";

export interface RefreshRelationshipsResult {
  /** Resolved state per DID, in request order. */
  resolved: ResolvedRelationship[];
  checked: number;
  /** How many came back `unknown` because a lookup failed. */
  unknown: number;
  /** Set when at least one chunk failed. */
  error: string | null;
}

/**
 * Read relationship truth for up to a few hundred DIDs and persist it.
 *
 * `persist: false` is used by the mutation path, which needs the truth
 * for a reconciliation decision and writes the candidate itself as part
 * of recording the action.
 */
export async function refreshRelationships(input: {
  workspaceId: string;
  operatorAccountId: string;
  actorDid: string;
  subjectDids: string[];
  persist?: boolean;
  appView?: string;
  fetchImpl?: typeof fetch;
  db?: SupabaseClient;
}): Promise<RefreshRelationshipsResult> {
  const dids = [...new Set(input.subjectDids.filter((d) => d.startsWith("did:")))];
  if (dids.length === 0) {
    return { resolved: [], checked: 0, unknown: 0, error: null };
  }

  const resolved: ResolvedRelationship[] = [];
  let firstError: string | null = null;

  for (const chunk of chunkDids(dids, GET_RELATIONSHIPS_MAX_OTHERS)) {
    const result = await getRelationships({
      actor: input.actorDid,
      others: chunk,
      appView: input.appView,
      fetchImpl: input.fetchImpl,
    });

    if (!result.ok) {
      // The ONLY way a failure reaches per-DID results. It cannot
      // produce anything but `unknown`.
      resolved.push(...relationshipsUnavailable(chunk, result));
      firstError ??= result.message;
      // Rate limiting and auth failures will not fix themselves within
      // this loop; stop asking and report what is known so far.
      if (result.kind === "rate_limited" || result.kind === "auth") {
        for (const remaining of dids.slice(resolved.length)) {
          resolved.push(...relationshipsUnavailable([remaining], result));
        }
        break;
      }
      continue;
    }

    for (const did of chunk) {
      const observation = result.observations.get(did);
      resolved.push(
        observation
          ? resolveRelationship(observation)
          : // getRelationships guarantees an entry per requested DID, so
            // this is unreachable. Stated rather than defaulted: if it
            // ever happens, the answer is unknown, never not_following.
            {
              did,
              state: "unknown" as const,
              followRecord: null,
              unknownReason:
                "Bluesky returned no entry for this account, so its relationship is unknown.",
            },
      );
    }
  }

  if (input.persist !== false) {
    for (const r of resolved) {
      await updateCandidateRelationship({
        workspaceId: input.workspaceId,
        operatorAccountId: input.operatorAccountId,
        subjectDid: r.did,
        state: r.state,
        error: r.unknownReason,
        // Only write follow-record identity when the provider gave us
        // one. Passing null here would erase an rkey captured at follow
        // time and leave a later unfollow with nothing safe to target.
        ...(r.followRecord
          ? {
              followUri: r.followRecord.uri,
              followRkey: r.followRecord.rkey,
              followRecordSource: "reconciled" as const,
            }
          : {}),
        db: input.db,
      });
    }
  }

  const unknown = resolved.filter((r) => r.state === "unknown").length;
  return { resolved, checked: resolved.length, unknown, error: firstError };
}
