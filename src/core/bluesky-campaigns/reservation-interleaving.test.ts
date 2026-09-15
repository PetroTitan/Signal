import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * The reservation-reuse race, reproduced deterministically.
 *
 * `Promise.all` over two dispatchers is not enough. Both workers run to
 * completion inside one JavaScript task queue, and whichever ordering
 * the scheduler happens to produce is the only one ever tested — the
 * dangerous interleaving may simply never occur.
 *
 * The dangerous window is narrow and specific:
 *
 *   A reserves N
 *   A finishes its members, clearing each lease in persist()
 *   ── HERE ── A has not settled yet, so nothing has been counted
 *   B reserves
 *   A settles
 *
 * At the marked instant every member A touched is unleased and the run
 * counters are still zero. A reservation inferred from lease status
 * sees no outstanding quota, concludes the day is untouched, and hands
 * B the whole quota a second time. A then settles into B's reservation.
 *
 * So this test STOPS worker A at that exact instant, runs B to
 * completion, and only then lets A settle. The assertion is on provider
 * calls, which is the number that reaches real people.
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
      connectionStatus: "connected",
      tokenGeneration: 0,
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

function countingProvider() {
  const calls = { createRecord: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({
        uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${calls.createRecord}`,
        cid: `cid${calls.createRecord}`,
      });
    }
    if (url.includes("getRelationships")) {
      const others = new URL(url).searchParams.getAll("others");
      return json({ actor: ACTOR, relationships: others.map((did) => ({ did })) });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function seed(db: FakeDb, memberCount: number, quota: number): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "interleaving",
      status: "active",
      requested_daily_quota: quota,
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
 * A client that suspends the FIRST settlement and hands back a release.
 *
 * Everything before settlement — the provider calls, the per-member
 * persists that clear each lease — has already happened when the gate
 * opens. That is precisely the window the race lived in.
 */
function gateOnFirstSettlement(db: FakeDb) {
  const real = db.client();
  let openGate!: () => void;
  let reportReached!: () => void;
  const gate = new Promise<void>((r) => {
    openGate = r;
  });
  const reached = new Promise<void>((r) => {
    reportReached = r;
  });
  let gated = false;

  const client = {
    from: real.from.bind(real),
    rpc: (async (fn: string, args: Record<string, unknown>) => {
      if (fn === "apply_bluesky_run_outcome" && !gated) {
        gated = true;
        reportReached();
        await gate;
      }
      return real.rpc(fn, args);
    }) as unknown as typeof real.rpc,
  } as unknown as ReturnType<FakeDb["client"]>;

  return { client, reached, release: () => openGate() };
}

/**
 * Lapse the dispatch lease the running worker holds.
 *
 * Models the two ways a second dispatcher legitimately enters a
 * campaign another one is still inside: a pass that runs longer than
 * its lease, and a function the platform killed and replaced.
 */
function expireDispatchLease(db: FakeDb): void {
  for (const run of db.rows("bluesky_follow_campaign_runs")) {
    run.dispatch_lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
  }
}

const dispatch = (
  db: FakeDb,
  impl: typeof fetch,
  client?: ReturnType<FakeDb["client"]>,
) => {
  db.setNow(NOW);
  return dispatchCampaigns({
    nowIso: NOW,
    db: client ?? db.client(),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the dispatch lease serialises dispatchers per campaign-day", () => {
  it("a second dispatcher is turned away while the first holds the lease", async () => {
    // The FIRST line of defence, and the one that makes the
    // consecutive-failure breaker meaningful: "consecutive" is a
    // property of a sequence, and two interleaved workers do not have
    // one.
    const db = new FakeDb();
    seed(db, 1000, 100);
    const p = countingProvider();
    const gate = gateOnFirstSettlement(db);

    const a = dispatch(db, p.impl, gate.client);
    await gate.reached;

    const b = await dispatch(db, p.impl);
    expect(b.campaignsRun).toBe(0);
    expect(b.notes.join(" ")).toContain("another dispatcher holds this campaign");

    gate.release();
    await a;
  });
});

describe("worker B reserving inside worker A's unsettled window", () => {
  it("cannot hand out quota A has already spent", async () => {
    const db = new FakeDb();
    // Quota 100, plenty of members, so the QUOTA is the binding limit.
    seed(db, 1000, 100);
    const p = countingProvider();

    const gate = gateOnFirstSettlement(db);

    // A runs until it is about to settle its first chunk.
    const a = dispatch(db, p.impl, gate.client);
    await gate.reached;

    // The window: A's members are all unleased and A has not settled.
    //
    // The run counters are NOT zero here, and that is the fix. Quota is
    // consumed at provider intent, one member at a time, so every
    // follow A really made is already in `attempted_count` — settled or
    // not, alive or not. When attempts were reported in bulk at
    // settlement this read zero, and the day's remaining quota was
    // computed from that zero.
    const leased = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "claimed" || m.status === "running");
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(Number(run.attempted_count)).toBeGreaterThan(0);
    expect(leased.length).toBeLessThan(20);

    // And every one of those units carries an immutable ledger stamp.
    const intents = db
      .rows("bluesky_campaign_attempt_ledger")
      .filter((l) => l.provider_intent_at);
    expect(intents.length).toBe(Number(run.attempted_count));

    // A's reservation is still open, and what remains on it is only the
    // units it has not spent yet.
    const open = db
      .rows("bluesky_campaign_quota_reservations")
      .filter((r) => r.status === "open");
    expect(open.length).toBeGreaterThan(0);

    // Lapse A's dispatch lease so B genuinely proceeds.
    //
    // Without this B is turned away at the door and the reservation
    // layer is never exercised — the test would pass while proving
    // nothing about it. The dispatch lease is the FIRST defence and is
    // asserted separately below; this case is about the SECOND, which
    // is what has to hold when a pass outlives its lease or the
    // platform kills and restarts a function mid-chunk.
    expireDispatchLease(db);

    // B now runs to completion inside that window.
    await dispatch(db, p.impl);

    // And only then does A settle.
    gate.release();
    await a;

    // THE assertion. With lease-derived reservations this was ~120.
    expect(p.calls.createRecord).toBeLessThanOrEqual(100);
    expect(p.calls.createRecord).toBeGreaterThan(0);
  });

  it("A's late settlement does not consume B's reservation", async () => {
    const db = new FakeDb();
    seed(db, 1000, 100);
    const p = countingProvider();
    const gate = gateOnFirstSettlement(db);

    const a = dispatch(db, p.impl, gate.client);
    await gate.reached;
    expireDispatchLease(db);
    await dispatch(db, p.impl);
    gate.release();
    await a;

    // Every reservation ends settled or released — none stranded open,
    // and none settled twice.
    const reservations = db.rows("bluesky_campaign_quota_reservations");
    expect(reservations.length).toBeGreaterThan(0);
    for (const r of reservations) {
      expect(["settled", "expired", "held"]).toContain(String(r.status));
    }
    // The run's cached reserved_count agrees with the rows that own it.
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    const outstanding = reservations
      .filter((r) => r.status === "open" || r.status === "held")
      .reduce((sum, r) => sum + Number(r.reserved_count), 0);
    expect(Number(run.reserved_count)).toBe(outstanding);
  });

  it("counters never exceed the quota after the interleaving", async () => {
    const db = new FakeDb();
    seed(db, 1000, 100);
    const p = countingProvider();
    const gate = gateOnFirstSettlement(db);

    const a = dispatch(db, p.impl, gate.client);
    await gate.reached;
    expireDispatchLease(db);
    await dispatch(db, p.impl);
    gate.release();
    await a;

    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(Number(run.attempted_count)).toBeLessThanOrEqual(100);
    expect(Number(run.succeeded_count)).toBeLessThanOrEqual(100);
    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(Number(usage.follows_created)).toBeLessThanOrEqual(100);
    // And the provider agrees with the books.
    expect(Number(run.succeeded_count)).toBe(p.calls.createRecord);
  });

  it("settling the same reservation twice applies nothing twice", async () => {
    const db = new FakeDb();
    seed(db, 40, 100);
    const p = countingProvider();
    await dispatch(db, p.impl);

    const settled = db
      .rows("bluesky_campaign_quota_reservations")
      .find((r) => r.status === "settled");
    expect(settled).toBeTruthy();

    const run = db.rows("bluesky_follow_campaign_runs")[0];
    const before = Number(run.attempted_count);

    const replay = await db.client().rpc("apply_bluesky_run_outcome", {
      p_workspace_id: WS,
      p_campaign_id: CAMPAIGN,
      p_run_id: run.id,
      p_operator_account_id: IDENTITY,
      p_usage_date: "2026-09-11",
      p_reservation_id: settled!.id,
      p_consecutive_failures: 0,
      p_rate_limited_until: null,
      p_rate_limit_remaining: null,
      p_rate_limit_reset_at: null,
    });

    const row = (replay.data as { already_settled: boolean }[])[0];
    expect(row.already_settled).toBe(true);
    expect(Number(db.rows("bluesky_follow_campaign_runs")[0].attempted_count)).toBe(
      before,
    );
  });

  it("a reservation belonging to another run settles nothing", async () => {
    const db = new FakeDb();
    seed(db, 40, 100);
    await dispatch(db, countingProvider().impl);

    const run = db.rows("bluesky_follow_campaign_runs")[0];
    const before = Number(run.attempted_count);

    const foreign = await db.client().rpc("apply_bluesky_run_outcome", {
      p_workspace_id: WS,
      p_campaign_id: CAMPAIGN,
      p_run_id: run.id,
      p_operator_account_id: IDENTITY,
      p_usage_date: "2026-09-11",
      // A reservation id that does not exist — stands in for one
      // belonging to a different run.
      p_reservation_id: "reservation-does-not-exist",
      p_consecutive_failures: 0,
      p_rate_limited_until: null,
      p_rate_limit_remaining: null,
      p_rate_limit_reset_at: null,
    });

    const row = (foreign.data as { settled: boolean }[])[0];
    expect(row.settled).toBe(false);
    expect(Number(db.rows("bluesky_follow_campaign_runs")[0].attempted_count)).toBe(
      before,
    );
  });
});

describe("a quota that runs out DURING the pass", () => {
  it("closes the day's run and schedules tomorrow", async () => {
    // The dispatcher used to decide this from a `quotaRemaining` figure
    // computed BEFORE the loop. That figure is stale the moment any
    // chunk runs, so a campaign that spent its quota mid-pass left the
    // run open and `next_run_at` unchanged — and the dispatcher woke on
    // it every five minutes until midnight, reserving nothing each
    // time. The reservation now reports WHY it granted nothing.
    const db = new FakeDb();
    // 1000 members, quota 40: the quota binds, and it is reached during
    // the pass rather than before it.
    seed(db, 1000, 40);
    const p = countingProvider();

    await dispatch(db, p.impl);

    expect(p.calls.createRecord).toBe(40);
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(run.status).toBe("completed");
    expect(run.completed_at).toBeTruthy();

    // Scheduled for a LATER day, not five minutes from now.
    const campaign = db.rows("bluesky_follow_campaigns")[0];
    const nextRun = Date.parse(String(campaign.next_run_at));
    expect(nextRun).toBeGreaterThan(Date.parse(NOW) + 6 * 60 * 60 * 1000);
    // And the campaign is still active — the queue is not exhausted.
    expect(campaign.status).toBe("active");
  });

  it("an exhausted QUEUE completes the campaign instead", async () => {
    const db = new FakeDb();
    seed(db, 10, 100);
    const p = countingProvider();
    await dispatch(db, p.impl);

    expect(p.calls.createRecord).toBe(10);
    expect(db.rows("bluesky_follow_campaigns")[0].status).toBe("completed");
  });

  it("a second tick after the quota is spent reserves nothing more", async () => {
    const db = new FakeDb();
    seed(db, 1000, 40);
    const p = countingProvider();
    await dispatch(db, p.impl);
    await dispatch(db, p.impl);
    await dispatch(db, p.impl);
    expect(p.calls.createRecord).toBe(40);
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
  });
});
