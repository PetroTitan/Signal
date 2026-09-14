/**
 * The identity of the record an unfollow is allowed to delete.
 *
 * Pure. No I/O, no clock, no database. Everything here is about one
 * question: *is this exactly the record we mean, in the repository we
 * are acting as, in the collection that holds follows?*
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * `com.atproto.repo.deleteRecord` is documented as "Delete a repository
 * record, **or ensure it doesn't exist**". It is idempotent, and that
 * is exactly what makes it dangerous to be casual with: deleting a
 * record key that is wrong-but-real succeeds quietly and removes a
 * relationship nobody asked about, while deleting one that is simply
 * absent also succeeds and tells you nothing. The provider will not
 * catch a mistake here, so the check has to happen before the request.
 *
 * THE RULE THAT GENERATES ALL THE OTHERS
 * --------------------------------------
 * **An rkey is never derived.** There is no function from a subject DID
 * to a record key. The relationship subsystem recorded why, from
 * observation: rkeys returned in a single provider response used
 * incompatible schemes — `did_plc_z72i7hdy…`, a mangled subject DID,
 * alongside `zP0yDDN2oUGcWA`, a TID. Any derivation rule is wrong for
 * most rows, and "wrong" here means deleting a different person's
 * follow.
 *
 * So every rkey in this system has a provenance, and it is always a
 * provider reading: `listRecords` over the acting repository, or
 * `getRelationships().following` parsed by `rkeyFromAtUri`.
 */

export const FOLLOW_COLLECTION = "app.bsky.graph.follow";

/** Where an rkey came from. There is deliberately no "derived". */
export type RecordSource = "create_record" | "list_records" | "relationship_read";

export interface FollowRecordIdentity {
  uri: string;
  rkey: string;
  cid: string | null;
  source: RecordSource;
}

export type RecordValidation =
  | { ok: true; identity: FollowRecordIdentity }
  | { ok: false; code: RecordRefusal; message: string };

export type RecordRefusal =
  | "missing_rkey"
  | "missing_uri"
  | "malformed_uri"
  | "wrong_repository"
  | "wrong_collection"
  | "rkey_uri_mismatch";

/**
 * Validate a candidate delete target against the acting session.
 *
 * The whole tuple is checked because each part names a different thing
 * that can go wrong:
 *
 *   repository  — a record in another repo is not ours to delete, and a
 *                 delete aimed at one would either fail or, if the
 *                 session somehow had rights, remove a stranger's data.
 *   collection  — an rkey is only unique within a collection. The same
 *                 key can name a like, a block or a post, and
 *                 `deleteRecord` takes the collection as a parameter,
 *                 so a wrong collection deletes a real record of the
 *                 wrong kind.
 *   rkey ↔ uri  — the two must agree. They come from the same provider
 *                 row, so disagreement means something reassembled them,
 *                 and the assembly is the part that could be wrong.
 */
export function validateFollowRecordTarget(input: {
  actorDid: string;
  uri: string | null | undefined;
  rkey: string | null | undefined;
  cid?: string | null;
  source: RecordSource;
}): RecordValidation {
  const rkey = (input.rkey ?? "").trim();
  if (rkey.length === 0) {
    return {
      ok: false,
      code: "missing_rkey",
      message:
        "No follow-record key is known for this profile, so there is nothing safe to delete. Signal reads the record from Bluesky rather than guessing one.",
    };
  }

  const uri = (input.uri ?? "").trim();
  if (uri.length === 0) {
    return {
      ok: false,
      code: "missing_uri",
      message:
        "The follow record's address is missing, so its owner cannot be confirmed. Nothing was deleted.",
    };
  }

  if (!uri.startsWith("at://")) {
    return {
      ok: false,
      code: "malformed_uri",
      message: "The follow record's address is not an AT-URI. Nothing was deleted.",
    };
  }

  const segments = uri.slice("at://".length).split("/");
  if (segments.length !== 3) {
    return {
      ok: false,
      code: "malformed_uri",
      message:
        "The follow record's address is not in the form at://<repo>/<collection>/<key>. Nothing was deleted.",
    };
  }

  const [repo, collection, key] = segments;

  if (repo !== input.actorDid) {
    return {
      ok: false,
      code: "wrong_repository",
      message:
        "That follow record belongs to a different Bluesky account than the one acting. Nothing was deleted.",
    };
  }

  if (collection !== FOLLOW_COLLECTION) {
    return {
      ok: false,
      code: "wrong_collection",
      message:
        "That record is not a follow. Deleting it would remove something else entirely, so nothing was deleted.",
    };
  }

  if (key !== rkey) {
    return {
      ok: false,
      code: "rkey_uri_mismatch",
      message:
        "The follow record's key and address disagree, so the exact record cannot be identified. Nothing was deleted.",
    };
  }

  return {
    ok: true,
    identity: { uri, rkey, cid: input.cid ?? null, source: input.source },
  };
}

/**
 * Decide which reading to act on, given what the queue stored at import
 * and what the provider says right now.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * A queue may be frozen for weeks. In that time the operator can
 * unfollow someone by hand and follow them again — which mints a NEW
 * record under a NEW rkey and destroys the old one. The stored key now
 * names a record that no longer exists.
 *
 * Deleting it would SUCCEED, because `deleteRecord` "ensures it doesn't
 * exist" and it already doesn't. Signal would record an unfollow, the
 * operator would see one, and the live follow would still be there.
 * That is a silent lie about a public relationship, produced by code
 * that looks like it worked.
 *
 * So the fresh reading always wins, and a divergence is reported rather
 * than smoothed over.
 */
export type TargetResolution =
  | {
      kind: "delete";
      identity: FollowRecordIdentity;
      /** True when the stored key was stale and has been replaced. */
      replacedStoredKey: boolean;
    }
  /** The provider says the follow is not there. Neutral success. */
  | { kind: "already_absent" }
  /**
   * The relationship could not be read. NOT an observation of absence —
   * the whole relationship subsystem is built on that distinction — so
   * nothing is deleted and the member is tried again later.
   */
  | { kind: "unknown"; reason: string }
  /** A target was offered and refused. */
  | { kind: "refused"; code: RecordRefusal; message: string };

export function resolveDeleteTarget(input: {
  actorDid: string;
  /** What the queue stored when it was built. May be stale. */
  stored: { uri: string | null; rkey: string | null; cid: string | null };
  /**
   * What the provider says NOW.
   *   "following" with a record → delete that one
   *   "not_following"          → already absent
   *   "unknown"                → we did not find out
   */
  live:
    | { state: "following"; uri: string; rkey: string }
    | { state: "not_following" }
    | { state: "unknown"; reason: string };
}): TargetResolution {
  if (input.live.state === "unknown") {
    return { kind: "unknown", reason: input.live.reason };
  }

  if (input.live.state === "not_following") {
    // Observed, not inferred. The provider answered and reported no
    // follow edge, which is the only thing that produces this branch.
    return { kind: "already_absent" };
  }

  const validation = validateFollowRecordTarget({
    actorDid: input.actorDid,
    uri: input.live.uri,
    rkey: input.live.rkey,
    // The live relationship read does not return a CID. The stored one
    // is reused ONLY when it describes the same record — otherwise it
    // belongs to a record that no longer exists, and sending it as
    // `swapRecord` would make the provider refuse a delete that is
    // perfectly correct.
    cid: input.stored.rkey === input.live.rkey ? input.stored.cid : null,
    source: "relationship_read",
  });

  if (!validation.ok) {
    return { kind: "refused", code: validation.code, message: validation.message };
  }

  return {
    kind: "delete",
    identity: validation.identity,
    replacedStoredKey:
      input.stored.rkey !== null && input.stored.rkey !== input.live.rkey,
  };
}
