import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * `reconciliation_required` is terminal for the ACTION and unresolved
 * for the MEMBER.
 *
 * The worker mapped EVERY terminal claim to member status `succeeded`.
 * The claim RPC treats `succeeded`, `failed` AND
 * `reconciliation_required` as terminal, so a member whose follow was
 * never confirmed — or which structurally failed — was reported to the
 * operator as followed, and the campaign counted it as done.
 *
 * That is the worst possible failure mode for this feature: it is a
 * lie about a public action taken in the operator's name, and it is
 * invisible because everything downstream agrees.
 *
 * Three passes, because two are not enough to catch it: the false
 * success only appears once an action has REACHED
 * `reconciliation_required` and is then claimed again.
 *
 * No real follow is performed: every provider call is a counted stub.
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function seed(db: FakeDb, memberCount: number): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "reconcile",
      status: "active",
      requested_daily_quota: 100,
      timezone: "UTC",
      execution_window_start_minute: 0,
      execution_window_end_minute: 1440,
      start_date: null,
      dry_run: false,
      max_consecutive_failures: 5,
      min_success_rate_percent: 50,
      next_run_at: null,
      rate_limited_until: null,
      completed_at: null,
      created_by: "user-1",
    },
  ]);
  const members: Row[] = [];
  for (let i = 1; i <= memberCount; i += 1) {
    members.push({
      id: `m${i}`,
      workspace_id: WS,
      campaign_id: CAMPAIGN,
      subject_did: `did:plc:s${i}`,
      current_handle: `h${i}.bsky.social`,
      import_sequence: i,
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      claimed_at: null,
      claimed_by: null,
      lease_expires_at: null,
      provider_record_uri: null,
      provider_record_rkey: null,
      provider_record_cid: null,
    });
  }
  db.tables.set("bluesky_follow_campaign_members", members);
  db.tables.set("bluesky_campaign_kill_switches", []);
  db.tables.set("bluesky_identity_daily_usage", []);
  db.tables.set("bluesky_follow_campaign_runs", []);
  db.tables.set("bluesky_relationship_actions", []);
  db.tables.set("bluesky_campaign_quota_reservations", []);
}

/**
 * The durable state a killed serverless function leaves: no catch, no
 * finally, no cleanup. Every lease simply lapses on its own clock.
 */
function simulateProcessDeath(db: FakeDb): void {
  const campaign = db.rows("bluesky_follow_campaigns")[0];
  campaign.status = "active";
  campaign.last_error_code = null;
  campaign.last_error_message = null;
  const run = db.rows("bluesky_follow_campaign_runs")[0];
  if (run) {
    run.status = "running";
    run.dispatch_lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
  }
  for (const r of db.rows("bluesky_campaign_quota_reservations")) {
    if (r.status === "open") {
      r.expires_at = new Date(db.nowMs() - 1000).toISOString();
    }
  }
  for (const m of db.rows("bluesky_follow_campaign_members")) {
    if (m.status === "claimed" || m.status === "running") {
      m.lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
    }
  }
}

/** Kills the process on the first attempt to finalise an audit row. */
function crashAfterProviderSuccess(db: FakeDb) {
  const calls = { createRecord: 0 };
  const real = db.client();
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({ uri: `at://${ACTOR}/app.bsky.graph.follow/3ok`, cid: "cid" });
    }
    if (url.includes("getRelationships")) {
      const others = new URL(url).searchParams.getAll("others");
      return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
    }
    return json({});
  }) as unknown as typeof fetch;

  const client = {
    rpc: real.rpc.bind(real),
    from: (table: string) => {
      const builder = real.from(table);
      if (table !== "bluesky_relationship_actions") return builder;
      const update = builder.update.bind(builder);
      builder.update = ((values: unknown) => {
        if (calls.createRecord >= 1) {
          throw new Error("process terminated after provider success");
        }
        return update(values as never);
      }) as typeof builder.update;
      return builder;
    },
  } as unknown as ReturnType<FakeDb["client"]>;

  return { impl, calls, client };
}

/** Reads fail; mutations would succeed if anyone were reckless enough. */
function readsFailProvider() {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({ uri: "at://x", cid: "y" });
    }
    calls.relationships += 1;
    return json({ error: "InternalServerError" }, 500);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Reads succeed and report the follow does NOT exist. */
function readsSayNotFollowing() {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({ uri: "at://x", cid: "y" });
    }
    calls.relationships += 1;
    const others = new URL(url).searchParams.getAll("others");
    return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Reads succeed and CONFIRM the follow exists. */
function readsConfirmFollowing() {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({ uri: "at://x", cid: "y" });
    }
    calls.relationships += 1;
    const others = new URL(url).searchParams.getAll("others");
    return json({
      actor: ACTOR,
      relationships: others.map((d) => ({
        did: d,
        following: `at://${ACTOR}/app.bsky.graph.follow/3pre`,
      })),
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 10 minutes later. Past the member's backoff and the run's next hint. */
const LATER = "2026-09-11T12:10:00Z";

const dispatch = (
  db: FakeDb,
  impl: typeof fetch,
  client?: ReturnType<FakeDb["client"]>,
  nowIso: string = NOW,
) => {
  db.setNow(nowIso);
  return dispatchCampaigns({
    nowIso,
    db: client ?? db.client(),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
};

const action = (db: FakeDb) => db.rows("bluesky_relationship_actions")[0];
const member = (db: FakeDb) => db.rows("bluesky_follow_campaign_members")[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("three passes over an unconfirmable follow", () => {
  it("never reports success without provider confirmation", async () => {
    const db = new FakeDb();
    seed(db, 1);

    // ── Pass 1: the provider succeeds, then the process dies.
    const first = crashAfterProviderSuccess(db);
    await dispatch(db, first.impl, first.client);
    expect(first.calls.createRecord).toBe(1);
    expect(action(db).provider_in_flight_at).toBeTruthy();
    simulateProcessDeath(db);

    // ── Pass 2: reconciliation, and the RELATIONSHIP READ FAILS.
    const second = readsFailProvider();
    await dispatch(db, second.impl);

    expect(second.calls.createRecord).toBe(0);
    expect(action(db).status).toBe("reconciliation_required");
    expect(member(db).status).toBe("retryable");

    // ── Pass 3: the action is now TERMINAL as far as the claim RPC is
    //    concerned. This is the pass that used to report success.
    const third = readsSayNotFollowing();
    await dispatch(db, third.impl, undefined, LATER);

    // Zero mutations, still.
    expect(third.calls.createRecord).toBe(0);
    // And emphatically NOT succeeded.
    expect(member(db).status).not.toBe("succeeded");
    expect(member(db).status).not.toBe("already_following");
    expect(action(db).status).toBe("reconciliation_required");
    // The run never counted a follow that was never confirmed.
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(Number(run.succeeded_count)).toBe(0);
    expect(Number(run.already_following_count)).toBe(0);
  });

  it("resolves ONLY when Bluesky confirms the follow", async () => {
    const db = new FakeDb();
    seed(db, 1);

    const first = crashAfterProviderSuccess(db);
    await dispatch(db, first.impl, first.client);
    simulateProcessDeath(db);

    await dispatch(db, readsFailProvider().impl);
    expect(action(db).status).toBe("reconciliation_required");

    // Now the AppView catches up and reports the follow.
    //
    // Ten minutes later, because that is how this actually happens: a
    // day whose quota is spent but which still has an unresolved action
    // schedules itself to come back shortly rather than closing, and
    // the member is past its retry backoff by then.
    const confirming = readsConfirmFollowing();
    await dispatch(db, confirming.impl, undefined, LATER);

    expect(confirming.calls.createRecord).toBe(0);
    expect(action(db).status).toBe("succeeded");
    expect(member(db).status).toBe("already_following");
  });

  it("a reconciliation pass consumes neither an attempt nor quota", async () => {
    const db = new FakeDb();
    seed(db, 1);

    const first = crashAfterProviderSuccess(db);
    await dispatch(db, first.impl, first.client);
    simulateProcessDeath(db);

    const attemptsBefore = Number(member(db).attempt_count);
    const runBefore = Number(
      db.rows("bluesky_follow_campaign_runs")[0].attempted_count,
    );

    await dispatch(db, readsFailProvider().impl);
    await dispatch(db, readsFailProvider().impl, undefined, LATER);

    // A read-only pass that sends nothing must not spend an attempt —
    // otherwise MAX_MEMBER_ATTEMPTS eventually marks an UNRESOLVED
    // member `failed_structural` without a single request being made.
    expect(Number(member(db).attempt_count)).toBe(attemptsBefore);
    expect(
      Number(db.rows("bluesky_follow_campaign_runs")[0].attempted_count),
    ).toBe(runBefore);
  });

  it("a terminal FAILED action never becomes a succeeded member", async () => {
    const db = new FakeDb();
    seed(db, 1);

    // Drive the member to a structural failure by hand: the action row
    // is terminal-failed and the member is back in the queue, which is
    // what a manual requeue produces.
    db.rows("bluesky_relationship_actions").push({
      id: "act-1",
      workspace_id: WS,
      operator_account_id: IDENTITY,
      action_type: "follow",
      subject_did: "did:plc:s1",
      status: "failed",
      campaign_id: CAMPAIGN,
      campaign_run_id: null,
      campaign_member_id: "m1",
      provider_in_flight_at: null,
    });

    const p = readsSayNotFollowing();
    await dispatch(db, p.impl);

    expect(p.calls.createRecord).toBe(0);
    expect(member(db).status).toBe("failed_structural");
    expect(member(db).status).not.toBe("succeeded");
  });

  it("a terminal SUCCEEDED action still short-circuits to succeeded", async () => {
    // The one case where the old mapping was right, kept honest.
    const db = new FakeDb();
    seed(db, 1);
    db.rows("bluesky_relationship_actions").push({
      id: "act-1",
      workspace_id: WS,
      operator_account_id: IDENTITY,
      action_type: "follow",
      subject_did: "did:plc:s1",
      status: "succeeded",
      campaign_id: CAMPAIGN,
      campaign_run_id: null,
      campaign_member_id: "m1",
      provider_in_flight_at: null,
    });

    const p = readsSayNotFollowing();
    await dispatch(db, p.impl);

    expect(p.calls.createRecord).toBe(0);
    expect(member(db).status).toBe("succeeded");
  });
});
