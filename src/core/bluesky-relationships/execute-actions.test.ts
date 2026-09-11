import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb, type Row } from "./test-support/fake-db";
import {
  executeFollowAction,
  executeUnfollowAction,
  processBatchActions,
  type RelationshipStateByDid,
} from "./execute-actions.server";
import {
  confirmBatch,
  createAction,
  createBatch,
  DuplicateActiveActionError,
  BatchMembershipFrozenError,
} from "@/repositories/bluesky-relationship-repository";
import type { RelationshipSession } from "./session.server";
import type { BlueskyRelationshipActionRow } from "@/lib/supabase/types";

const WORKSPACE = "ws-1";
const IDENTITY = "acct-1";
const ACTOR_DID = "did:plc:operator";
const SUBJECT = "did:plc:subject";

function session(): RelationshipSession {
  return {
    ok: true,
    actorDid: ACTOR_DID,
    actorHandle: "operator.bsky.social",
    accessJwt: "jwt-value",
    service: "https://bsky.social",
    connectionId: "conn-1",
    refreshOnce: async () => ({
      ok: false,
      code: "session_expired",
      message: "no",
    }),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A fetch script keyed by endpoint. Records every call so a test can
 * assert how MANY mutations were sent, which is how the "never blindly
 * retries" controls are made observable.
 */
function scriptedFetch(script: {
  createRecord?: (n: number) => Response;
  deleteRecord?: (n: number) => Response;
  relationships?: (n: number) => Response;
}) {
  const calls = { createRecord: 0, deleteRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return (
        script.createRecord?.(calls.createRecord) ??
        json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3new`, cid: "cid1" })
      );
    }
    if (url.includes("deleteRecord")) {
      calls.deleteRecord += 1;
      return script.deleteRecord?.(calls.deleteRecord) ?? json({});
    }
    if (url.includes("getRelationships")) {
      calls.relationships += 1;
      return (
        script.relationships?.(calls.relationships) ??
        json({ actor: ACTOR_DID, relationships: [{ did: SUBJECT }] })
      );
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function seedCandidate(db: FakeDb, over: Row = {}): Row {
  const row: Row = {
    id: "cand-1",
    workspace_id: WORKSPACE,
    operator_account_id: IDENTITY,
    subject_did: SUBJECT,
    handle: "subject.bsky.social",
    display_name: "Subject",
    relationship_state: "not_following",
    protected: false,
    follow_uri: null,
    follow_rkey: null,
    follow_cid: null,
    follow_record_source: null,
    followed_at: null,
    unfollowed_at: null,
    ...over,
  };
  db.rows("bluesky_candidates").push(row);
  return row;
}

async function seedAction(
  db: FakeDb,
  actionType: "follow" | "unfollow",
  over: Partial<Row> = {},
): Promise<BlueskyRelationshipActionRow> {
  return (await createAction({
    workspaceId: WORKSPACE,
    operatorAccountId: IDENTITY,
    candidateId: "cand-1",
    batchId: null,
    actionType,
    subjectDid: SUBJECT,
    subjectHandleAtAction: "subject.bsky.social",
    actorDid: ACTOR_DID,
    actorHandleAtAction: "operator.bsky.social",
    sourceTargetProfileIds: ["target-1"],
    initiatedBy: "user-1",
    initiatorKind: "operator_single",
    db: db.client(),
    ...over,
  })) as BlueskyRelationshipActionRow;
}

const ctxFor = (db: FakeDb, fetchImpl: typeof fetch) => ({
  workspaceId: WORKSPACE,
  operatorAccountId: IDENTITY,
  session: session(),
  fetchImpl,
  db: db.client(),
});

// =====================================================================
// Follow
// =====================================================================

describe("executeFollowAction", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("persists the EXACT provider record identity a later unfollow needs", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl } = scriptedFetch({
      createRecord: () =>
        json({
          uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3exactkey`,
          cid: "bafyreiexact",
        }),
    });

    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });

    expect(result.status).toBe("succeeded");
    const stored = db.rows("bluesky_candidates")[0];
    expect(stored.follow_uri).toBe(
      `at://${ACTOR_DID}/app.bsky.graph.follow/3exactkey`,
    );
    // The rkey is the provider's, parsed — not derived from the DID.
    expect(stored.follow_rkey).toBe("3exactkey");
    expect(stored.follow_rkey).not.toContain("did");
    expect(stored.follow_cid).toBe("bafyreiexact");
    expect(stored.follow_record_source).toBe("create_record");
    expect(stored.relationship_state).toBe("following");

    const recorded = db.rows("bluesky_relationship_actions")[0];
    expect(recorded.follow_rkey).toBe("3exactkey");
    expect(recorded.follow_cid).toBe("bafyreiexact");
  });

  it("following someone who already follows you records mutual", async () => {
    seedCandidate(db, { relationship_state: "follows_you" });
    const action = await seedAction(db, "follow");
    const { impl } = scriptedFetch({});
    await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "follows_you",
    });
    expect(db.rows("bluesky_candidates")[0].relationship_state).toBe("mutual");
  });

  it("skips an already-following candidate without contacting the provider", async () => {
    seedCandidate(db, { relationship_state: "following" });
    const action = await seedAction(db, "follow");
    const { impl, calls } = scriptedFetch({});
    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
    });
    expect(result.status).toBe("skipped");
    expect(calls.createRecord).toBe(0);
  });

  it("an AMBIGUOUS follow reads truth and sends exactly ONE createRecord", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl, calls } = scriptedFetch({
      // Every attempt fails ambiguously. If the code retried, the count
      // would climb.
      createRecord: () => json({ error: "InternalServerError" }, 500),
      relationships: () =>
        json({
          actor: ACTOR_DID,
          relationships: [
            {
              did: SUBJECT,
              following: `at://${ACTOR_DID}/app.bsky.graph.follow/3landed`,
            },
          ],
        }),
    });

    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });

    expect(calls.createRecord).toBe(1);
    expect(calls.relationships).toBe(1);
    // Truth says the follow landed, so this is a success — reconciled,
    // not re-sent.
    expect(result.status).toBe("succeeded");
    const recorded = db.rows("bluesky_relationship_actions")[0];
    expect(recorded.reconciled_state).toBe("following");
    expect(recorded.follow_rkey).toBe("3landed");
  });

  it("an ambiguous follow whose truth says NOT following stops at reconciliation_required", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl, calls } = scriptedFetch({
      createRecord: () => json({ error: "BadGateway" }, 502),
      relationships: () => json({ actor: ACTOR_DID, relationships: [{ did: SUBJECT }] }),
    });

    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });

    expect(result.status).toBe("reconciliation_required");
    // Still exactly one mutation. The read said "not following" and the
    // code still did not send a second follow, because the AppView
    // indexes writes with a delay.
    expect(calls.createRecord).toBe(1);
    const recorded = db.rows("bluesky_relationship_actions")[0];
    expect(recorded.status).toBe("reconciliation_required");
    expect(String(recorded.reconciliation_note)).toContain("not proof");
  });

  it("an ambiguous follow whose RECONCILE ALSO fails stays unknown, not not_following", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl, calls } = scriptedFetch({
      createRecord: () => json({ error: "InternalServerError" }, 500),
      relationships: () => json({ error: "InternalServerError" }, 500),
    });

    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });

    expect(result.status).toBe("reconciliation_required");
    expect(calls.createRecord).toBe(1);
    expect(db.rows("bluesky_candidates")[0].relationship_state).toBe("unknown");
    expect(db.rows("bluesky_relationship_actions")[0].reconciled_state).toBe(
      "unknown",
    );
  });

  it("a definitive 400 is a failure, and sends no relationship read", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl, calls } = scriptedFetch({
      createRecord: () => json({ error: "InvalidRequest", message: "bad" }, 400),
    });
    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });
    expect(result.status).toBe("failed");
    expect(calls.createRecord).toBe(1);
    expect(calls.relationships).toBe(0);
  });

  it("a PDS that reports 'already exists' reconciles instead of failing", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl } = scriptedFetch({
      createRecord: () =>
        json({ error: "RecordAlreadyExists", message: "Record already exists" }, 400),
      relationships: () =>
        json({
          actor: ACTOR_DID,
          relationships: [
            {
              did: SUBJECT,
              following: `at://${ACTOR_DID}/app.bsky.graph.follow/3preexisting`,
            },
          ],
        }),
    });
    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });
    expect(result.status).toBe("succeeded");
    // The pre-existing record's key is learned, so a future unfollow
    // has something safe to target.
    expect(db.rows("bluesky_candidates")[0].follow_rkey).toBe("3preexisting");
  });

  it("a rate limit halts without marking the action failed", async () => {
    seedCandidate(db);
    const action = await seedAction(db, "follow");
    const { impl } = scriptedFetch({
      createRecord: () =>
        json({ error: "RateLimitExceeded" }, 429, { "retry-after": "60" }),
    });
    const result = await executeFollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });
    expect(result.halt).not.toBeNull();
    expect(result.halt?.resumable).toBe(true);
    // Left pending so a resume picks it up rather than the operator
    // having to re-select it.
    expect(result.status).toBe("pending");
  });
});

// =====================================================================
// Unfollow
// =====================================================================

describe("executeUnfollowAction", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("deletes using the stored rkey and clears the record identity", async () => {
    seedCandidate(db, {
      relationship_state: "following",
      follow_rkey: "3stored",
      follow_cid: "cidstored",
      follow_uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3stored`,
    });
    const action = await seedAction(db, "unfollow");
    let sentBody: Record<string, unknown> = {};
    const impl = (async (url: string, init: RequestInit) => {
      if (url.includes("deleteRecord")) {
        sentBody = JSON.parse(String(init.body));
        return json({});
      }
      return json({});
    }) as unknown as typeof fetch;

    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: "3stored",
      follow_cid: "cidstored",
    });

    expect(result.status).toBe("succeeded");
    expect(sentBody.rkey).toBe("3stored");
    expect(sentBody.swapRecord).toBe("cidstored");
    const stored = db.rows("bluesky_candidates")[0];
    expect(stored.relationship_state).toBe("not_following");
    expect(stored.follow_rkey).toBeNull();
    expect(stored.follow_uri).toBeNull();
  });

  it("unfollowing a mutual leaves follows_you, not not_following", async () => {
    seedCandidate(db, { relationship_state: "mutual", follow_rkey: "3m" });
    const action = await seedAction(db, "unfollow");
    const { impl } = scriptedFetch({});
    await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "mutual",
      protected: false,
      follow_rkey: "3m",
      follow_cid: null,
    });
    // Removing our edge does not remove theirs.
    expect(db.rows("bluesky_candidates")[0].relationship_state).toBe("follows_you");
  });

  it("REFUSES a protected candidate and never contacts the provider", async () => {
    seedCandidate(db, {
      relationship_state: "following",
      protected: true,
      follow_rkey: "3p",
    });
    const action = await seedAction(db, "unfollow");
    const { impl, calls } = scriptedFetch({});
    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: true,
      follow_rkey: "3p",
      follow_cid: null,
    });
    expect(result.status).toBe("skipped");
    expect(String(result.message)).toContain("Protected");
    expect(calls.deleteRecord).toBe(0);
    // And no reconciliation read either — protection short-circuits
    // before anything else.
    expect(calls.relationships).toBe(0);
  });

  it("with NO stored rkey it reconciles for the real key rather than guessing", async () => {
    seedCandidate(db, { relationship_state: "following", follow_rkey: null });
    const action = await seedAction(db, "unfollow");
    let deletedRkey: string | null = null;
    const impl = (async (url: string, init: RequestInit) => {
      if (url.includes("getRelationships")) {
        return json({
          actor: ACTOR_DID,
          relationships: [
            {
              did: SUBJECT,
              following: `at://${ACTOR_DID}/app.bsky.graph.follow/3fromprovider`,
            },
          ],
        });
      }
      if (url.includes("deleteRecord")) {
        deletedRkey = JSON.parse(String(init.body)).rkey;
        return json({});
      }
      return json({});
    }) as unknown as typeof fetch;

    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: null,
      follow_cid: null,
    });

    expect(result.status).toBe("succeeded");
    // The key came from the provider. A derivation would have produced
    // something containing the DID.
    expect(deletedRkey).toBe("3fromprovider");
  });

  it("with no rkey AND no provider record it records the observation and deletes nothing", async () => {
    seedCandidate(db, { relationship_state: "following", follow_rkey: null });
    const action = await seedAction(db, "unfollow");
    const { impl, calls } = scriptedFetch({
      relationships: () => json({ actor: ACTOR_DID, relationships: [{ did: SUBJECT }] }),
    });
    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: null,
      follow_cid: null,
    });
    expect(calls.deleteRecord).toBe(0);
    // The provider says we do not follow them, so the desired state
    // already holds.
    expect(result.status).toBe("succeeded");
  });

  it("an AMBIGUOUS unfollow sends exactly ONE deleteRecord despite idempotence", async () => {
    seedCandidate(db, { relationship_state: "following", follow_rkey: "3x" });
    const action = await seedAction(db, "unfollow");
    const { impl, calls } = scriptedFetch({
      deleteRecord: () => json({ error: "InternalServerError" }, 500),
      relationships: () =>
        json({
          actor: ACTOR_DID,
          relationships: [
            { did: SUBJECT, following: `at://${ACTOR_DID}/app.bsky.graph.follow/3x` },
          ],
        }),
    });
    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: "3x",
      follow_cid: null,
    });
    expect(calls.deleteRecord).toBe(1);
    expect(result.status).toBe("reconciliation_required");
    expect(String(result.message)).toContain("did not re-send");
  });

  it("an ambiguous unfollow whose truth says gone is a success", async () => {
    seedCandidate(db, { relationship_state: "following", follow_rkey: "3x" });
    const action = await seedAction(db, "unfollow");
    const { impl, calls } = scriptedFetch({
      deleteRecord: () => json({ error: "Gateway" }, 502),
      relationships: () => json({ actor: ACTOR_DID, relationships: [{ did: SUBJECT }] }),
    });
    const result = await executeUnfollowAction(ctxFor(db, impl), action, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: "3x",
      follow_cid: null,
    });
    expect(result.status).toBe("succeeded");
    expect(calls.deleteRecord).toBe(1);
  });
});

// =====================================================================
// Duplicate-action guard and batch membership
// =====================================================================

describe("duplicate active actions", () => {
  it("a second in-flight follow for the same DID is refused by the database", async () => {
    const db = new FakeDb();
    seedCandidate(db);
    await seedAction(db, "follow");
    await expect(seedAction(db, "follow")).rejects.toBeInstanceOf(
      DuplicateActiveActionError,
    );
    expect(db.rows("bluesky_relationship_actions")).toHaveLength(1);
  });

  it("an unfollow may run while a follow is in flight — different action types", async () => {
    const db = new FakeDb();
    seedCandidate(db);
    await seedAction(db, "follow");
    await expect(seedAction(db, "unfollow")).resolves.toBeTruthy();
  });

  it("a NEW follow is allowed once the previous one reached a terminal state", async () => {
    const db = new FakeDb();
    seedCandidate(db);
    const first = await seedAction(db, "follow");
    db.rows("bluesky_relationship_actions").find(
      (r) => r.id === first.id,
    )!.status = "succeeded";
    await expect(seedAction(db, "follow")).resolves.toBeTruthy();
    // And history keeps BOTH — the first is never rewritten.
    expect(db.rows("bluesky_relationship_actions")).toHaveLength(2);
  });
});

describe("batch membership is immutable once confirmed", () => {
  it("refuses to insert an action into a confirmed batch", async () => {
    const db = new FakeDb();
    seedCandidate(db);
    const batch = await createBatch({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      actionType: "follow",
      createdBy: "user-1",
      db: db.client(),
    });
    await seedAction(db, "follow", { batchId: batch.id });
    await confirmBatch({
      workspaceId: WORKSPACE,
      batchId: batch.id,
      requestedCount: 1,
      confirmedBy: "user-1",
      db: db.client(),
    });

    // A newly imported candidate tries to join the approved work.
    await expect(
      createAction({
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        candidateId: "cand-new",
        batchId: batch.id,
        actionType: "follow",
        subjectDid: "did:plc:newly-imported",
        subjectHandleAtAction: "new.bsky.social",
        actorDid: ACTOR_DID,
        actorHandleAtAction: "operator.bsky.social",
        sourceTargetProfileIds: [],
        initiatedBy: "user-1",
        initiatorKind: "operator_batch",
        db: db.client(),
      }),
    ).rejects.toBeInstanceOf(BatchMembershipFrozenError);

    expect(
      db.rows("bluesky_relationship_actions").filter((r) => r.batch_id === batch.id),
    ).toHaveLength(1);
  });

  it("confirmBatch freezes requested_count at the membership that existed", async () => {
    const db = new FakeDb();
    const batch = await createBatch({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      actionType: "follow",
      createdBy: "user-1",
      db: db.client(),
    });
    for (const did of ["did:plc:a", "did:plc:b", "did:plc:c"]) {
      await createAction({
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        candidateId: null,
        batchId: batch.id,
        actionType: "follow",
        subjectDid: did,
        subjectHandleAtAction: null,
        actorDid: ACTOR_DID,
        actorHandleAtAction: null,
        sourceTargetProfileIds: [],
        initiatedBy: "user-1",
        initiatorKind: "operator_batch",
        db: db.client(),
      });
    }
    const confirmed = await confirmBatch({
      workspaceId: WORKSPACE,
      batchId: batch.id,
      requestedCount: 3,
      confirmedBy: "user-1",
      db: db.client(),
    });
    expect(confirmed.requested_count).toBe(3);
    expect(confirmed.confirmed_at).toBeTruthy();
  });
});

// =====================================================================
// Batch processing
// =====================================================================

describe("processBatchActions", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  async function buildBatch(dids: string[], type: "follow" | "unfollow" = "follow") {
    const actions: BlueskyRelationshipActionRow[] = [];
    const candidates: RelationshipStateByDid = new Map();
    for (const did of dids) {
      actions.push(
        (await createAction({
          workspaceId: WORKSPACE,
          operatorAccountId: IDENTITY,
          candidateId: null,
          batchId: null,
          actionType: type,
          subjectDid: did,
          subjectHandleAtAction: `${did}.example`,
          actorDid: ACTOR_DID,
          actorHandleAtAction: "operator.bsky.social",
          sourceTargetProfileIds: [],
          initiatedBy: "user-1",
          initiatorKind: "operator_batch",
          db: db.client(),
        })) as BlueskyRelationshipActionRow,
      );
      candidates.set(did, {
        subject_did: did,
        relationship_state: type === "follow" ? "not_following" : "following",
        protected: false,
        follow_rkey: type === "unfollow" ? "3rk" : null,
        follow_cid: null,
      });
    }
    return { actions, candidates };
  }

  it("processes every member of a fixed list and counts the outcomes", async () => {
    const { actions, candidates } = await buildBatch([
      "did:plc:1",
      "did:plc:2",
      "did:plc:3",
    ]);
    const { impl, calls } = scriptedFetch({});
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.processed).toBe(3);
    expect(progress.succeeded).toBe(3);
    expect(calls.createRecord).toBe(3);
  });

  it("a partial failure does not stop the batch or the others' progress", async () => {
    const { actions, candidates } = await buildBatch([
      "did:plc:1",
      "did:plc:2",
      "did:plc:3",
    ]);
    const { impl } = scriptedFetch({
      createRecord: (n) =>
        n === 2
          ? json({ error: "InvalidRequest", message: "bad subject" }, 400)
          : json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3ok${n}`, cid: "c" }),
    });
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.processed).toBe(3);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.halted).toBe(false);
  });

  it("stops on a rate limit, keeps progress, and leaves the rest untouched", async () => {
    const { actions, candidates } = await buildBatch([
      "did:plc:1",
      "did:plc:2",
      "did:plc:3",
      "did:plc:4",
    ]);
    const { impl, calls } = scriptedFetch({
      createRecord: (n) =>
        n >= 3
          ? json({ error: "RateLimitExceeded" }, 429)
          : json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3ok${n}`, cid: "c" }),
    });
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.succeeded).toBe(2);
    expect(progress.halted).toBe(true);
    expect(progress.resumable).toBe(true);
    expect(progress.remaining).toBe(2);
    // It STOPPED. It did not keep hammering the remaining rows.
    expect(calls.createRecord).toBe(3);
    expect(
      db.rows("bluesky_relationship_actions").filter((r) => r.status === "pending"),
    ).toHaveLength(2);
  });

  it("stops BEFORE the provider's window is exhausted", async () => {
    const { actions, candidates } = await buildBatch(["did:plc:1", "did:plc:2"]);
    const { impl, calls } = scriptedFetch({
      createRecord: (n) =>
        json(
          { uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3ok${n}`, cid: "c" },
          200,
          { "ratelimit-remaining": "3", "ratelimit-limit": "3000" },
        ),
    });
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(calls.createRecord).toBe(1);
    expect(progress.halted).toBe(true);
    expect(String(progress.haltReason)).toContain("3 requests left");
  });

  it("stops and does not resume on an auth failure", async () => {
    const { actions, candidates } = await buildBatch(["did:plc:1", "did:plc:2"]);
    const { impl } = scriptedFetch({
      createRecord: () => json({ error: "ExpiredToken" }, 401),
    });
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.halted).toBe(true);
    expect(progress.resumable).toBe(false);
    expect(progress.processed).toBe(0);
  });

  it("excludes a protected member even if it reached the action list", async () => {
    const { actions, candidates } = await buildBatch(
      ["did:plc:1", "did:plc:2"],
      "unfollow",
    );
    candidates.set("did:plc:2", {
      subject_did: "did:plc:2",
      relationship_state: "following",
      protected: true,
      follow_rkey: "3rk",
      follow_cid: null,
    });
    const { impl, calls } = scriptedFetch({});
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "unfollow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.succeeded).toBe(1);
    expect(progress.skipped).toBe(1);
    // One delete sent, for the unprotected one only.
    expect(calls.deleteRecord).toBe(1);
  });

  it("treats an unreadable candidate row as UNKNOWN, never as not_following", async () => {
    const { actions } = await buildBatch(["did:plc:1"], "unfollow");
    const { impl, calls } = scriptedFetch({
      relationships: () => json({ actor: ACTOR_DID, relationships: [{ did: "did:plc:1" }] }),
    });
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "unfollow",
      actions,
      // Deliberately empty: the executor has no candidate row.
      candidates: new Map(),
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    // Unknown proceeds to a reconcile rather than being skipped as
    // "not following" — the key point is that it did NOT delete blind.
    expect(calls.deleteRecord).toBe(0);
    expect(progress.processed).toBe(1);
  });

  it("processes ONLY the actions it was handed, never a query for more", async () => {
    const { actions, candidates } = await buildBatch(["did:plc:1"]);
    // A candidate imported after the batch was built.
    db.rows("bluesky_candidates").push({
      id: "cand-late",
      workspace_id: WORKSPACE,
      operator_account_id: IDENTITY,
      subject_did: "did:plc:late-arrival",
      relationship_state: "not_following",
      protected: false,
    });
    const { impl, calls } = scriptedFetch({});
    const progress = await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async () => undefined,
      interRequestMs: 0,
    });
    expect(progress.processed).toBe(1);
    expect(calls.createRecord).toBe(1);
  });

  it("spaces requests uniformly with no randomisation", async () => {
    const { actions, candidates } = await buildBatch([
      "did:plc:1",
      "did:plc:2",
      "did:plc:3",
    ]);
    const delays: number[] = [];
    const { impl } = scriptedFetch({});
    await processBatchActions({
      ctx: ctxFor(db, impl),
      actionType: "follow",
      actions,
      candidates,
      sleep: async (ms) => {
        delays.push(ms);
      },
      interRequestMs: 750,
    });
    // Between requests only — never after the last one — and every
    // value identical. Jitter would show up here as variance.
    expect(delays).toEqual([750, 750]);
    expect(new Set(delays).size).toBe(1);
  });
});

// =====================================================================
// History preservation
// =====================================================================

describe("history is never erased by a later state change", () => {
  it("an unfollow adds a row; the follow that preceded it still stands", async () => {
    const db = new FakeDb();
    seedCandidate(db);

    const followAction = await seedAction(db, "follow");
    const { impl } = scriptedFetch({});
    await executeFollowAction(ctxFor(db, impl), followAction, {
      subject_did: SUBJECT,
      relationship_state: "not_following",
    });

    const unfollowAction = await seedAction(db, "unfollow");
    await executeUnfollowAction(ctxFor(db, impl), unfollowAction, {
      subject_did: SUBJECT,
      relationship_state: "following",
      protected: false,
      follow_rkey: "3new",
      follow_cid: null,
    });

    const history = db.rows("bluesky_relationship_actions");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.action_type).sort()).toEqual(["follow", "unfollow"]);
    expect(history.every((h) => h.status === "succeeded")).toBe(true);
    // The follow record's identity is still in the follow's own row,
    // even though the candidate's copy has been cleared.
    expect(history.find((h) => h.action_type === "follow")!.follow_rkey).toBe("3new");
    expect(db.rows("bluesky_candidates")[0].follow_rkey).toBeNull();
  });

  it("keeps the handle as it was at action time, not the current one", async () => {
    const db = new FakeDb();
    seedCandidate(db);
    await seedAction(db, "follow");
    // The account renames itself afterwards.
    db.rows("bluesky_candidates")[0].handle = "renamed-later.bsky.social";
    expect(db.rows("bluesky_relationship_actions")[0].subject_handle_at_action).toBe(
      "subject.bsky.social",
    );
  });
});
