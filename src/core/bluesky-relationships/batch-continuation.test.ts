import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb, type Row } from "./test-support/fake-db";
import {
  processBatchActions,
  type RelationshipStateByDid,
} from "./execute-actions.server";
import {
  confirmBatch,
  createAction,
  createBatch,
  getBatch,
  listBatchActions,
  updateBatchProgress,
} from "@/repositories/bluesky-relationship-repository";
import type { RelationshipSession } from "./session.server";
import type { BlueskyRelationshipActionRow } from "@/lib/supabase/types";

/**
 * Continuing a paused batch.
 *
 * These exercise the executor and repository that the continuation
 * action composes. The action's own authorization is asserted
 * structurally in `authorization.test.ts`, because it needs a Next
 * request scope vitest does not provide.
 *
 * The property under test is the one an operator depends on: continuing
 * resumes EXACTLY the rows that were never attempted, from the frozen
 * membership, and touches nothing else. Every assertion counts provider
 * calls rather than reading a return value, because "it did not re-send
 * that one" is only meaningful if the request was never made.
 */

const WS = "ws";
const ID = "acct";
const ACTOR = "did:plc:operator";

const session = (): RelationshipSession => ({
  ok: true,
  actorDid: ACTOR,
  actorHandle: "op.bsky.social",
  accessJwt: "jwt",
  service: "https://bsky.social",
  connectionId: "c",
  refreshOnce: async () => ({
    ok: false,
    code: "session_expired",
    message: "no",
  }),
});

const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "content-type": "application/json", ...h },
  });

/** A confirmed batch of `n` follow actions, with matching candidates. */
async function confirmedBatch(db: FakeDb, n: number) {
  const batch = await createBatch({
    workspaceId: WS,
    operatorAccountId: ID,
    actionType: "follow",
    createdBy: "u",
    db: db.client(),
  });
  for (let i = 0; i < n; i += 1) {
    const did = `did:plc:s${i}`;
    db.rows("bluesky_candidates").push({
      id: `cand-${i}`,
      workspace_id: WS,
      operator_account_id: ID,
      subject_did: did,
      handle: `h${i}.bsky.social`,
      relationship_state: "not_following",
      protected: false,
      follow_rkey: null,
      follow_cid: null,
    } as Row);
    await createAction({
      workspaceId: WS,
      operatorAccountId: ID,
      candidateId: `cand-${i}`,
      batchId: batch.id,
      actionType: "follow",
      subjectDid: did,
      subjectHandleAtAction: `h${i}.bsky.social`,
      actorDid: ACTOR,
      actorHandleAtAction: "op.bsky.social",
      sourceTargetProfileIds: [],
      initiatedBy: "u",
      initiatorKind: "operator_batch",
      db: db.client(),
    });
  }
  await confirmBatch({
    workspaceId: WS,
    batchId: batch.id,
    requestedCount: n,
    confirmedBy: "u",
    db: db.client(),
  });
  return { batch };
}

function candidateMap(db: FakeDb): RelationshipStateByDid {
  return new Map(
    db.rows("bluesky_candidates").map((c) => [
      String(c.subject_did),
      {
        subject_did: String(c.subject_did),
        relationship_state: c.relationship_state as never,
        protected: Boolean(c.protected),
        follow_rkey: (c.follow_rkey as string | null) ?? null,
        follow_cid: (c.follow_cid as string | null) ?? null,
      },
    ]),
  );
}

/** Run actions, throttling from the `throttleAt`-th provider call on. */
async function run(
  db: FakeDb,
  actions: BlueskyRelationshipActionRow[],
  throttleAt: number,
) {
  let calls = 0;
  const progress = await processBatchActions({
    ctx: {
      workspaceId: WS,
      operatorAccountId: ID,
      session: session(),
      db: db.client(),
      fetchImpl: (async (u: string) => {
        if (!u.includes("createRecord")) return json({});
        calls += 1;
        return calls >= throttleAt
          ? json({ error: "RateLimitExceeded" }, 429, { "retry-after": "60" })
          : json({
              uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${calls}`,
              cid: "c",
            });
      }) as unknown as typeof fetch,
    },
    actionType: "follow",
    actions,
    candidates: candidateMap(db),
    sleep: async () => undefined,
    interRequestMs: 0,
  });
  return { progress, calls };
}

const pendingOf = async (db: FakeDb, batchId: string) =>
  (await listBatchActions(WS, batchId, db.client())).filter(
    (a) => a.status === "pending",
  );

describe("a paused batch continues exactly its remaining rows", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("resumes the untouched rows and leaves the finished ones alone", async () => {
    const { batch } = await confirmedBatch(db, 8);
    const all = await listBatchActions(WS, batch.id, db.client());

    // Throttled on the 4th call, so 3 succeed.
    const first = await run(db, all, 4);
    expect(first.progress.halted).toBe(true);
    expect(first.progress.succeeded).toBe(3);

    const afterFirst = await listBatchActions(WS, batch.id, db.client());
    const succeededIds = afterFirst
      .filter((a) => a.status === "succeeded")
      .map((a) => a.id);
    expect(succeededIds).toHaveLength(3);
    // Nothing abandoned mid-flight.
    expect(afterFirst.filter((a) => a.status === "running")).toHaveLength(0);

    await updateBatchProgress({
      workspaceId: WS,
      batchId: batch.id,
      status: "paused",
      processed: 3,
      succeeded: 3,
      failed: 0,
      reconciliationRequired: 0,
      stopReason: "provider",
      lastError: "rate limited",
      db: db.client(),
    });

    // Continue with ONLY the pending rows, as the action does.
    const pending = await pendingOf(db, batch.id);
    expect(pending).toHaveLength(5);
    const second = await run(db, pending, 999);

    // Five provider calls, not eight: the three that already succeeded
    // are never re-sent.
    expect(second.calls).toBe(5);
    expect(second.progress.processed).toBe(5);

    const final = await listBatchActions(WS, batch.id, db.client());
    expect(final.filter((a) => a.status === "succeeded")).toHaveLength(8);
    expect(final.filter((a) => a.status === "pending")).toHaveLength(0);
    for (const id of succeededIds) {
      const row = final.find((a) => a.id === id)!;
      expect(row.status).toBe("succeeded");
      expect(row.follow_rkey).toBeTruthy();
    }
  });

  it("never re-sends a reconciliation_required row", async () => {
    const { batch } = await confirmedBatch(db, 3);
    const all = await listBatchActions(WS, batch.id, db.client());
    db.rows("bluesky_relationship_actions").find(
      (r) => r.id === all[0].id,
    )!.status = "reconciliation_required";

    const pending = await pendingOf(db, batch.id);
    expect(pending).toHaveLength(2);

    const { calls } = await run(db, pending, 999);
    // Two calls, not three. The ambiguous one stays where it is: the
    // whole point of that state is that the next move is a human's.
    expect(calls).toBe(2);
    const final = await listBatchActions(WS, batch.id, db.client());
    expect(final.find((a) => a.id === all[0].id)!.status).toBe(
      "reconciliation_required",
    );
  });

  it("never retries a failed row", async () => {
    const { batch } = await confirmedBatch(db, 3);
    const all = await listBatchActions(WS, batch.id, db.client());
    db.rows("bluesky_relationship_actions").find(
      (r) => r.id === all[0].id,
    )!.status = "failed";

    const { calls } = await run(db, await pendingOf(db, batch.id), 999);
    // A failed row was a definitive provider refusal, not an unknown.
    expect(calls).toBe(2);
  });

  it("a candidate imported AFTER confirmation cannot join the continuation", async () => {
    const { batch } = await confirmedBatch(db, 2);
    db.rows("bluesky_candidates").push({
      id: "cand-late",
      workspace_id: WS,
      operator_account_id: ID,
      subject_did: "did:plc:late",
      handle: "late.bsky.social",
      relationship_state: "not_following",
      protected: false,
      follow_rkey: null,
      follow_cid: null,
    } as Row);

    let admitted = true;
    try {
      await createAction({
        workspaceId: WS,
        operatorAccountId: ID,
        candidateId: "cand-late",
        batchId: batch.id,
        actionType: "follow",
        subjectDid: "did:plc:late",
        subjectHandleAtAction: "late.bsky.social",
        actorDid: ACTOR,
        actorHandleAtAction: null,
        sourceTargetProfileIds: [],
        initiatedBy: "u",
        initiatorKind: "operator_batch",
        db: db.client(),
      });
    } catch {
      admitted = false;
    }
    expect(admitted).toBe(false);

    const membership = await listBatchActions(WS, batch.id, db.client());
    expect(membership).toHaveLength(2);
    expect(membership.map((a) => a.subject_did)).not.toContain("did:plc:late");

    const { calls } = await run(db, membership, 999);
    expect(calls).toBe(2);
  });

  it("protection applied after confirmation still excludes the row", async () => {
    const db2 = new FakeDb();
    const batch = await createBatch({
      workspaceId: WS,
      operatorAccountId: ID,
      actionType: "unfollow",
      createdBy: "u",
      db: db2.client(),
    });
    for (let i = 0; i < 2; i += 1) {
      db2.rows("bluesky_candidates").push({
        id: `c${i}`,
        workspace_id: WS,
        operator_account_id: ID,
        subject_did: `did:plc:u${i}`,
        handle: `u${i}.bsky.social`,
        relationship_state: "following",
        protected: false,
        follow_rkey: "3rk",
        follow_cid: null,
      } as Row);
      await createAction({
        workspaceId: WS,
        operatorAccountId: ID,
        candidateId: `c${i}`,
        batchId: batch.id,
        actionType: "unfollow",
        subjectDid: `did:plc:u${i}`,
        subjectHandleAtAction: null,
        actorDid: ACTOR,
        actorHandleAtAction: null,
        sourceTargetProfileIds: [],
        initiatedBy: "u",
        initiatorKind: "operator_batch",
        db: db2.client(),
      });
    }
    await confirmBatch({
      workspaceId: WS,
      batchId: batch.id,
      requestedCount: 2,
      confirmedBy: "u",
      db: db2.client(),
    });

    // Protected between confirmation and continuation. The continuation
    // reads TODAY's candidate state, not the state at confirmation.
    db2.rows("bluesky_candidates").find((c) => c.id === "c1")!.protected = true;

    let deletes = 0;
    const actions = await listBatchActions(WS, batch.id, db2.client());
    const progress = await processBatchActions({
      ctx: {
        workspaceId: WS,
        operatorAccountId: ID,
        session: session(),
        db: db2.client(),
        fetchImpl: (async (u: string) => {
          if (u.includes("deleteRecord")) deletes += 1;
          return json({});
        }) as unknown as typeof fetch,
      },
      actionType: "unfollow",
      actions,
      candidates: candidateMap(db2),
      sleep: async () => undefined,
      interRequestMs: 0,
    });

    expect(deletes).toBe(1);
    expect(progress.skipped).toBe(1);
    expect(progress.succeeded).toBe(1);
  });

  it("a second throttle pauses again with the rest still pending", async () => {
    const { batch } = await confirmedBatch(db, 9);
    await run(db, await listBatchActions(WS, batch.id, db.client()), 4);
    expect(await pendingOf(db, batch.id)).toHaveLength(6);

    await run(db, await pendingOf(db, batch.id), 3);
    expect(await pendingOf(db, batch.id)).toHaveLength(4);
    expect(
      (await listBatchActions(WS, batch.id, db.client())).filter(
        (a) => a.status === "running",
      ),
    ).toHaveLength(0);

    await run(db, await pendingOf(db, batch.id), 999);
    const final = await listBatchActions(WS, batch.id, db.client());
    expect(final.filter((a) => a.status === "succeeded")).toHaveLength(9);
    expect(final.filter((a) => a.status === "pending")).toHaveLength(0);
  });

  it("an auth failure leaves every row pending and the batch non-resumable", async () => {
    const { batch } = await confirmedBatch(db, 4);
    const all = await listBatchActions(WS, batch.id, db.client());

    const progress = await processBatchActions({
      ctx: {
        workspaceId: WS,
        operatorAccountId: ID,
        session: session(),
        db: db.client(),
        fetchImpl: (async (u: string) =>
          u.includes("createRecord")
            ? json({ error: "ExpiredToken" }, 401)
            : json({})) as unknown as typeof fetch,
      },
      actionType: "follow",
      actions: all,
      candidates: candidateMap(db),
      sleep: async () => undefined,
      interRequestMs: 0,
    });

    // Not resumable: continuing would just fail again. The action
    // refuses at resolveRelationshipSession until the operator
    // reconnects the identity.
    expect(progress.halted).toBe(true);
    expect(progress.resumable).toBe(false);
    expect(progress.processed).toBe(0);
    expect(await pendingOf(db, batch.id)).toHaveLength(4);
    expect(
      (await listBatchActions(WS, batch.id, db.client())).filter(
        (a) => a.status === "running",
      ),
    ).toHaveLength(0);
  });

  it("membership and requested_count are unchanged by any continuation", async () => {
    const { batch } = await confirmedBatch(db, 5);
    const before = await getBatch(WS, batch.id, db.client());

    await run(db, await listBatchActions(WS, batch.id, db.client()), 3);
    await run(db, await pendingOf(db, batch.id), 999);

    const after = await getBatch(WS, batch.id, db.client());
    expect(after!.requested_count).toBe(before!.requested_count);
    expect(after!.confirmed_at).toBe(before!.confirmed_at);
    expect(await listBatchActions(WS, batch.id, db.client())).toHaveLength(5);
  });
});

describe("a batch in another workspace is not reachable", () => {
  it("getBatch will not return it across a workspace boundary", async () => {
    const db = new FakeDb();
    const { batch } = await confirmedBatch(db, 2);
    expect(await getBatch("ws-OTHER", batch.id, db.client())).toBeNull();
    expect(await getBatch(WS, batch.id, db.client())).not.toBeNull();
  });

  it("listBatchActions will not return its rows across a workspace boundary", async () => {
    const db = new FakeDb();
    const { batch } = await confirmedBatch(db, 2);
    expect(await listBatchActions("ws-OTHER", batch.id, db.client())).toEqual([]);
  });
});
