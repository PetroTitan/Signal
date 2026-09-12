import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./test-support/fake-db";
import {
  executeFollowAction,
  executeUnfollowAction,
  processBatchActions,
} from "./execute-actions.server";
import type { RelationshipSession } from "./session.server";
import type {
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
} from "@/lib/supabase/types";

/**
 * Manual Follow and Unfollow against an expired session.
 *
 * The production failure, verbatim:
 *
 *     HTTP 400 {"error":"ExpiredToken","message":"Token has expired"}
 *
 * `refreshOnce()` had existed since the session layer was written and
 * had no production caller, because the status-keyed classifier never
 * produced an auth verdict for a 400. These tests count the provider
 * calls and the refreshes, because "it worked" is not the property —
 * "it worked using exactly one refresh and exactly two requests" is.
 *
 * No real follow is performed: every provider call is a counted stub.
 */

const WORKSPACE = "ws-1";
const IDENTITY = "acct-1";
const ACTOR_DID = "did:plc:operator";

const EXPIRED = JSON.stringify({
  error: "ExpiredToken",
  message: "Token has expired",
});
const INVALID = JSON.stringify({
  error: "InvalidToken",
  message: "Token could not be verified",
});

function json(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A session whose refresh succeeds once and then refuses, exactly as
 * the real one does — the session a refresh returns carries
 * `refreshAllowed: false`.
 */
function refreshableSession(counters: { refreshes: number }): RelationshipSession {
  const renewed: RelationshipSession = {
    ok: true,
    actorDid: ACTOR_DID,
    actorHandle: "operator.bsky.social",
    accessJwt: "jwt-NEW",
    service: "https://bsky.social",
    connectionId: "conn-1",
    refreshOnce: async () => ({
      ok: false,
      code: "session_expired",
      message: "Already refreshed once during this operation.",
    }),
  };
  return {
    ok: true,
    actorDid: ACTOR_DID,
    actorHandle: "operator.bsky.social",
    accessJwt: "jwt-OLD",
    service: "https://bsky.social",
    connectionId: "conn-1",
    refreshOnce: async () => {
      counters.refreshes += 1;
      return renewed;
    },
  };
}

function unrefreshableSession(counters: { refreshes: number }): RelationshipSession {
  return {
    ok: true,
    actorDid: ACTOR_DID,
    actorHandle: "operator.bsky.social",
    accessJwt: "jwt-OLD",
    service: "https://bsky.social",
    connectionId: "conn-1",
    refreshOnce: async () => {
      counters.refreshes += 1;
      return {
        ok: false,
        code: "session_expired",
        message: "The Bluesky session expired and could not be renewed.",
      };
    },
  };
}

/**
 * Records every bearer token the provider was called with, so a test
 * can prove the RETRY used the new one and the batch kept using it.
 */
function provider(script: (call: number, token: string) => Response) {
  const tokens: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    // The graph client sends `Authorization`; normalise the casing
    // rather than guess it.
    const raw = (init?.headers ?? {}) as Record<string, string>;
    const key = Object.keys(raw).find(
      (k) => k.toLowerCase() === "authorization",
    );
    const auth = String(key ? raw[key] : "").replace("Bearer ", "");
    tokens.push(auth);
    return script(tokens.length, auth);
  }) as unknown as typeof fetch;
  return { impl, tokens, get calls() { return tokens.length; } };
}

async function seed(db: FakeDb, type: "follow" | "unfollow", n = 1) {
  db.tables.set("bluesky_relationship_actions", []);
  db.tables.set("bluesky_candidates", []);
  const actions: BlueskyRelationshipActionRow[] = [];
  for (let i = 1; i <= n; i += 1) {
    const did = `did:plc:s${i}`;
    db.rows("bluesky_candidates").push({
      id: `cand-${i}`,
      workspace_id: WORKSPACE,
      operator_account_id: IDENTITY,
      subject_did: did,
      handle: `h${i}.bsky.social`,
      relationship_state: type === "follow" ? "not_following" : "following",
      protected: false,
      follow_rkey: type === "unfollow" ? `rkey-${i}` : null,
      follow_cid: type === "unfollow" ? `cid-${i}` : null,
    });
    const row = {
      id: `act-${i}`,
      workspace_id: WORKSPACE,
      operator_account_id: IDENTITY,
      action_type: type,
      subject_did: did,
      status: "pending",
      follow_rkey: type === "unfollow" ? `rkey-${i}` : null,
      follow_cid: type === "unfollow" ? `cid-${i}` : null,
      actor_did: ACTOR_DID,
    } as unknown as BlueskyRelationshipActionRow;
    db.rows("bluesky_relationship_actions").push(row as never);
    actions.push(row);
  }
  return actions;
}

const candidatesMap = (db: FakeDb) =>
  new Map(
    db.rows("bluesky_candidates").map((c) => [
      String(c.subject_did),
      {
        subject_did: String(c.subject_did),
        relationship_state: c.relationship_state as BlueskyRelationshipState,
        protected: false,
        follow_rkey: (c.follow_rkey as string | null) ?? null,
        follow_cid: (c.follow_cid as string | null) ?? null,
      },
    ]),
  );

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
});

describe("createRecord: expired, refreshed once, retried once", () => {
  it("succeeds on the retry with exactly two calls and one refresh", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    const p = provider((call) =>
      call === 1
        ? json(EXPIRED, 400)
        : json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3new`, cid: "c" }),
    );

    const result = await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    expect(result.status).toBe("succeeded");
    expect(result.halt).toBeNull();
    // THE assertions: two provider calls, one refresh.
    expect(p.calls).toBe(2);
    expect(counters.refreshes).toBe(1);
    // The retry used the ROTATED token, not the dead one.
    expect(p.tokens).toEqual(["jwt-OLD", "jwt-NEW"]);
  });

  it("InvalidToken takes the same path", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    const p = provider((call) =>
      call === 1
        ? json(INVALID, 400)
        : json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3new`, cid: "c" }),
    );

    const result = await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );
    expect(result.status).toBe("succeeded");
    expect(p.calls).toBe(2);
    expect(counters.refreshes).toBe(1);
  });
});

describe("deleteRecord: expired, refreshed once, retried once", () => {
  it("succeeds on the retry with exactly two calls and one refresh", async () => {
    const [action] = await seed(db, "unfollow");
    const counters = { refreshes: 0 };
    const p = provider((call) => (call === 1 ? json(EXPIRED, 400) : json({})));

    const result = await executeUnfollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    expect(result.status).toBe("succeeded");
    expect(p.calls).toBe(2);
    expect(counters.refreshes).toBe(1);
    expect(p.tokens).toEqual(["jwt-OLD", "jwt-NEW"]);
  });
});

describe("when the refresh cannot help", () => {
  it("a failed refresh stops the batch and attempts no later member", async () => {
    const actions = await seed(db, "follow", 4);
    const counters = { refreshes: 0 };
    const p = provider(() => json(EXPIRED, 400));

    const progress = await processBatchActions({
      ctx: {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: unrefreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      actionType: "follow",
      actions,
      candidates: candidatesMap(db),
      sleep: async () => undefined,
      interRequestMs: 0,
    });

    expect(progress.halted).toBe(true);
    // Resuming needs a person, not a later tick.
    expect(progress.resumable).toBe(false);
    // ONE member attempted, one call, one refresh. Nothing after it.
    expect(p.calls).toBe(1);
    expect(counters.refreshes).toBe(1);
    expect(progress.processed).toBe(0);
  });

  it("a retry that also fails sends nothing further", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    const p = provider(() => json(EXPIRED, 400));

    const result = await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    // Two calls, one refresh, then stop — never a third call and never
    // a second refresh. The refreshed session refuses, structurally.
    expect(p.calls).toBe(2);
    expect(counters.refreshes).toBe(1);
    expect(result.halt).not.toBeNull();
    expect(result.halt?.resumable).toBe(false);
  });

  it("an ambiguous outcome after the retry sends no further mutation", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    // Expired, then a 2xx with no usable record URI.
    const p = provider((call) =>
      call === 1 ? json(EXPIRED, 400) : json({ ok: true }),
    );

    const result = await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    // The relationship read that follows an ambiguous create is a READ,
    // never another createRecord.
    expect(counters.refreshes).toBe(1);
    expect(result.status).not.toBe("succeeded");
  });

  it("403 never triggers a refresh", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    const p = provider(() => json({ error: "Forbidden" }, 403));

    await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    expect(p.calls).toBe(1);
    expect(counters.refreshes).toBe(0);
  });

  it("AccountTakedown never triggers a refresh", async () => {
    const [action] = await seed(db, "follow");
    const counters = { refreshes: 0 };
    const p = provider(() =>
      json({ error: "AccountTakedown", message: "taken down" }, 400),
    );

    await executeFollowAction(
      {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      action,
      candidatesMap(db).get("did:plc:s1")!,
    );

    expect(p.calls).toBe(1);
    expect(counters.refreshes).toBe(0);
  });
});

describe("a batch refreshes once and reuses the new token", () => {
  it("four members, one refresh, and every later call uses the rotated token", async () => {
    const actions = await seed(db, "follow", 4);
    const counters = { refreshes: 0 };
    // Only the FIRST call sees the dead token; everything after must
    // already be carrying the new one.
    const p = provider((call) =>
      call === 1
        ? json(EXPIRED, 400)
        : json({ uri: `at://${ACTOR_DID}/app.bsky.graph.follow/3n${call}`, cid: "c" }),
    );

    const progress = await processBatchActions({
      ctx: {
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        session: refreshableSession(counters),
        fetchImpl: p.impl,
        db: db.client(),
      },
      actionType: "follow",
      actions,
      candidates: candidatesMap(db),
      sleep: async () => undefined,
      interRequestMs: 0,
    });

    expect(progress.halted).toBe(false);
    expect(progress.succeeded).toBe(4);
    // ONE refresh for the whole batch, not one per member.
    expect(counters.refreshes).toBe(1);
    // 4 members + 1 retry = 5 calls; the first is the only dead one.
    expect(p.calls).toBe(5);
    expect(p.tokens[0]).toBe("jwt-OLD");
    expect(p.tokens.slice(1)).toEqual(["jwt-NEW", "jwt-NEW", "jwt-NEW", "jwt-NEW"]);
  });
});
