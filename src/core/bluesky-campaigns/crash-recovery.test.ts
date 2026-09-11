import { describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * A worker dies immediately after the provider succeeded, before the
 * outcome was persisted locally.
 *
 * This is the worst case in the whole system. `createRecord` is not
 * idempotent — it mints a fresh rkey per call — so the follow exists on
 * Bluesky while Signal has no record of it. The lease then lapses and
 * the member returns to the queue. If the next worker simply retried,
 * the account would be followed twice, with two live follow records and
 * Signal tracking neither correctly.
 *
 * The requirement is absolute: the second worker must perform ZERO
 * additional Follow mutations. Every assertion below counts
 * `createRecord` calls, because that is the only number that
 * corresponds to something happening to a real person.
 */

const WS = "ws-1";
const CAMPAIGN = "camp-1";
const IDENTITY = "acct-1";
const ACTOR = "did:plc:operator";
const NOW = "2026-09-11T12:00:00Z";

vi.mock("@/core/bluesky-relationships/session.server", () => ({
  resolveRelationshipSession: vi.fn(async () => ({
    ok: true as const,
    actorDid: ACTOR,
    actorHandle: "op.bsky.social",
    accessJwt: "jwt",
    service: "https://bsky.social",
    connectionId: "conn",
    refreshOnce: async () => ({
      ok: false as const,
      code: "session_expired" as const,
      message: "no",
    }),
  })),
}));

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "content-type": "application/json" },
  });

function seed(db: FakeDb, count: number, over: Partial<Row> = {}): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN, workspace_id: WS, operator_account_id: IDENTITY,
      name: "crash test", status: "active", requested_daily_quota: 100,
      timezone: "UTC", execution_window_start_minute: 0,
      execution_window_end_minute: 1440, start_date: null, dry_run: false,
      max_consecutive_failures: 50, min_success_rate_percent: 0,
      next_run_at: null, rate_limited_until: null, completed_at: null,
      created_by: "user-1", ...over,
    },
  ]);
  const members: Row[] = [];
  for (let i = 1; i <= count; i += 1) {
    members.push({
      id: `m${i}`, workspace_id: WS, campaign_id: CAMPAIGN,
      subject_did: `did:plc:s${i}`, current_handle: `h${i}.bsky.social`,
      import_sequence: i, status: "queued", attempt_count: 0,
      next_attempt_at: null, claimed_at: null, claimed_by: null,
      lease_expires_at: null, provider_record_uri: null,
      provider_record_rkey: null, provider_record_cid: null,
    });
  }
  db.tables.set("bluesky_follow_campaign_members", members);
  db.tables.set("bluesky_campaign_kill_switches", []);
  db.tables.set("bluesky_identity_daily_usage", []);
  db.tables.set("bluesky_follow_campaign_runs", []);
  db.tables.set("bluesky_relationship_actions", []);
}

const dispatch = (
  db: FakeDb,
  impl: typeof fetch,
  over: Record<string, unknown> = {},
) => {
  db.setNow(String(over.nowIso ?? NOW));
  return dispatchCampaigns({
    nowIso: NOW, db: db.client(), fetchImpl: impl,
    sleep: async () => undefined, interRequestMs: 0, ...over,
  });
};
/** Dispatch through an injected client (used for the crash cases). */
const dispatchWith = (
  db: FakeDb,
  client: ReturnType<FakeDb["client"]>,
  impl: typeof fetch,
) => {
  db.setNow(NOW);
  return dispatchCampaigns({
    nowIso: NOW, db: client, fetchImpl: impl,
    sleep: async () => undefined, interRequestMs: 0,
  });
};

/**
 * The durable state a killed serverless function actually leaves.
 *
 * When Vercel terminates a function nothing in the process runs — no
 * catch, no finally, no cleanup. So the campaign stays ACTIVE (the
 * in-process error handler that would mark it `failed` never executes),
 * the action row keeps its in-flight marker, and the member stays
 * leased until the lease lapses.
 *
 * The test injects the throw in-process to reach the right moment, so
 * this undoes the one side effect a real kill would not have produced.
 */
function simulateProcessDeath(db: FakeDb): void {
  const campaign = db.rows("bluesky_follow_campaigns")[0];
  campaign.status = "active";
  campaign.last_error_code = null;
  campaign.last_error_message = null;
  const run = db.rows("bluesky_follow_campaign_runs")[0];
  if (run) run.status = "running";
  for (const m of db.rows("bluesky_follow_campaign_members")) {
    if (m.status === "claimed" || m.status === "running") {
      // Against the DATABASE clock, not this machine's. The lease was
      // issued from the injected `now`, so expiring it relative to the
      // real clock makes the reclaim depend on the hour the suite runs.
      m.lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
    }
  }
}

/** A provider that counts mutations and never fails. */
function healthyProvider(followingDids: string[] = []) {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({ uri: `at://${ACTOR}/app.bsky.graph.follow/3n`, cid: "c" });
    }
    if (url.includes("getRelationships")) {
      calls.relationships += 1;
      const others = new URL(url).searchParams.getAll("others");
      return json({
        actor: ACTOR,
        relationships: others.map((d) =>
          followingDids.includes(d)
            ? { did: d, following: `at://${ACTOR}/app.bsky.graph.follow/3pre` }
            : { did: d },
        ),
      });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * Simulate process death between provider success and local persist.
 *
 * Throwing from `fetch` does NOT model this: the graph client catches
 * transport exceptions and returns a `network` failure, which is a
 * dropped connection — the provider never acted. The dangerous case is
 * the opposite one, where the provider DID act and the process died
 * before recording it.
 *
 * So the kill point is the first write to the audit row AFTER the
 * mutation succeeded. At that instant the follow exists on Bluesky, the
 * action row is marked in-flight, and the member is still leased —
 * exactly the durable state a killed function leaves behind.
 */
function crashAfterProviderSuccess(db: FakeDb, killOnCall: number) {
  const calls = { createRecord: 0, relationships: 0 };
  const real = db.client();

  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({
        uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${calls.createRecord}`,
        cid: "cid",
      });
    }
    if (url.includes("getRelationships")) {
      calls.relationships += 1;
      const others = new URL(url).searchParams.getAll("others");
      return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
    }
    return json({});
  }) as unknown as typeof fetch;

  // A client that dies on the Nth attempt to finalise an audit row.
  const client = {
    rpc: real.rpc.bind(real),
    from: (table: string) => {
      const builder = real.from(table);
      if (table !== "bluesky_relationship_actions") return builder;
      const update = builder.update.bind(builder);
      builder.update = ((values: unknown) => {
        if (calls.createRecord >= killOnCall) {
          throw new Error("process terminated after provider success");
        }
        return update(values as never);
      }) as typeof builder.update;
      return builder;
    },
  } as unknown as ReturnType<FakeDb["client"]>;

  return { impl, calls, client };
}

describe("a crash after provider success is never retried", () => {
  it("the second worker performs ZERO additional Follow mutations", async () => {
    const db = new FakeDb();
    seed(db, 1, { requested_daily_quota: 100 });

    // Worker 1: the provider succeeds, then the process dies.
    const first = crashAfterProviderSuccess(db, 1);
    await dispatchWith(db, first.client, first.impl);
    expect(first.calls.createRecord).toBe(1);

    // The action row survives, marked in-flight: a createRecord MAY
    // have reached the provider.
    const action = db.rows("bluesky_relationship_actions")[0];
    expect(action).toBeTruthy();
    expect(action.campaign_member_id).toBe("m1");
    expect(action.provider_in_flight_at).toBeTruthy();

    // The lease lapses and the member returns to the queue.
    simulateProcessDeath(db);

    // Worker 2. The provider would happily create a SECOND record.
    const second = healthyProvider();
    await dispatch(db, second.impl);

    // THE assertion: not one more mutation.
    expect(second.calls.createRecord).toBe(0);
    // It did read relationship truth instead.
    expect(second.calls.relationships).toBeGreaterThan(0);
  });

  it("reconciliation concludes SUCCEEDED when the follow is visible", async () => {
    const db = new FakeDb();
    seed(db, 1, { requested_daily_quota: 100 });

    const first = crashAfterProviderSuccess(db, 1);
    await dispatchWith(db, first.client, first.impl);
    simulateProcessDeath(db);

    // The AppView now reports the follow the crashed worker made.
    const second = healthyProvider(["did:plc:s1"]);
    await dispatch(db, second.impl);

    expect(second.calls.createRecord).toBe(0);
    const member = db.rows("bluesky_follow_campaign_members")[0];
    expect(member.status).toBe("already_following");
    const action = db.rows("bluesky_relationship_actions")[0];
    expect(action.status).toBe("succeeded");
    expect(String(action.reconciliation_note)).toContain("nothing was re-sent");
  });

  it("an unknown relationship stays unknown — and still sends nothing", async () => {
    const db = new FakeDb();
    seed(db, 1, { requested_daily_quota: 100 });

    const first = crashAfterProviderSuccess(db, 1);
    await dispatchWith(db, first.client, first.impl);
    simulateProcessDeath(db);

    // The relationship read fails too: doubly unknown.
    let creates = 0;
    const impl = (async (url: string) => {
      if (url.includes("createRecord")) {
        creates += 1;
        return json({ uri: "x", cid: "y" });
      }
      return json({ error: "InternalServerError" }, 500);
    }) as unknown as typeof fetch;

    await dispatch(db, impl);

    // Unknown on top of unknown is the strongest reason NOT to send.
    expect(creates).toBe(0);
    const action = db.rows("bluesky_relationship_actions")[0];
    expect(action.status).toBe("reconciliation_required");
    expect(String(action.reconciliation_note)).toContain("Nothing was re-sent");
  });

  it("members after the crash point are unaffected", async () => {
    const db = new FakeDb();
    seed(db, 10, { requested_daily_quota: 100 });

    // Crash on the third of ten.
    const first = crashAfterProviderSuccess(db, 3);
    await dispatchWith(db, first.client, first.impl);
    expect(first.calls.createRecord).toBe(3);

    // Two succeeded and were persisted. The rest were still leased when
    // the process died — nothing ran to release them — so they sit in
    // `claimed` until their lease lapses. None consumed an attempt.
    const succeeded = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "succeeded");
    expect(succeeded).toHaveLength(2);
    const leased = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "claimed");
    expect(leased.length).toBeGreaterThan(0);
    for (const m of leased) expect(m.attempt_count).toBe(0);

    // And they come back: the next tick reclaims them and finishes.
    simulateProcessDeath(db);
    const second = healthyProvider();
    await dispatch(db, second.impl);
    expect(
      db.rows("bluesky_follow_campaign_members").filter((m) => m.status === "queued"),
    ).toEqual([]);
  });

  it("a terminal action is skipped entirely on a later pass", async () => {
    const db = new FakeDb();
    seed(db, 3, { requested_daily_quota: 100 });
    await dispatch(db, healthyProvider().impl);

    // Force every member back to the queue while their actions remain
    // terminal — the state a badly-timed manual requeue would produce.
    for (const m of db.rows("bluesky_follow_campaign_members")) {
      m.status = "queued";
      m.lease_expires_at = null;
      m.next_attempt_at = null;
    }

    const second = healthyProvider();
    await dispatch(db, second.impl);

    // The audit row already says succeeded, so nothing is re-sent.
    expect(second.calls.createRecord).toBe(0);
    expect(db.rows("bluesky_relationship_actions")).toHaveLength(3);
  });

  it("no row is left claimed or running after a crash and recovery", async () => {
    const db = new FakeDb();
    seed(db, 8, { requested_daily_quota: 100 });
    const first = crashAfterProviderSuccess(db, 4);
    await dispatchWith(db, first.client, first.impl);
    simulateProcessDeath(db);
    await dispatch(db, healthyProvider().impl);

    const stuck = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "claimed" || m.status === "running");
    expect(stuck).toEqual([]);
  });

  it("a leaked reservation is reclaimed on the next tick", async () => {
    const db = new FakeDb();
    seed(db, 5, { requested_daily_quota: 100 });
    const first = crashAfterProviderSuccess(db, 2);
    await dispatchWith(db, first.client, first.impl);

    // Right after the kill the reservation IS outstanding — nothing ran
    // to report the chunk's outcome. That is the honest intermediate
    // state, not a bug.
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(Number(run.reserved_count)).toBeGreaterThan(0);

    // The lease lapses, and the next reservation reclaims the quota
    // along with the rows. Without this a small daily quota could be
    // consumed entirely by one crash and block its own recovery.
    simulateProcessDeath(db);
    await dispatch(db, healthyProvider().impl);
    expect(Number(db.rows("bluesky_follow_campaign_runs")[0].reserved_count)).toBe(0);
  });
});
