import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * The claim RPC's ownership verdict, when it says NO.
 *
 * `claim_bluesky_campaign_action` can lose a race. Two workers reach the
 * same member — one holds a lease the other reclaimed after it lapsed —
 * and both try to create the audit row. The unique index lets exactly
 * one through; the loser lands in the RPC's `unique_violation` handler
 * and gets back the winner's row with:
 *
 *     may_mutate = false, needs_reconcile = false, terminal = false
 *
 * Every one of those is meaningful. It is not terminal (the winner is
 * still working), and it is NOT reconciliation (no provider intent
 * exists for this worker, and nothing has been sent on its behalf). It
 * means: this member is not yours, do nothing to it.
 *
 * The worker read `terminal` and `needsReconcile` and never read
 * `mayMutate` at all, so the denied verdict fell through to
 * `attemptFollow` — the losing worker sent a second follow for a member
 * another worker owned, and spent a unit of quota doing it.
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

function countingProvider() {
  const calls = { createRecord: 0, relationships: 0 };
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
  return { impl, calls };
}

function seed(db: FakeDb, memberCount: number): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "ownership",
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
  db.tables.set("bluesky_campaign_attempt_ledger", []);
}

/**
 * A client whose claim RPC always loses the race.
 *
 * This is exactly the row the `unique_violation` handler returns when
 * another worker created the audit row first and has not yet sent
 * anything: not terminal, nothing to reconcile, and not ours.
 *
 * `onClaim` also lets the test hand the member to the winner at that
 * instant, which is what makes the "did the loser touch someone else's
 * lease" question answerable.
 */
function losesEveryClaim(db: FakeDb, onClaim?: (memberId: string) => void) {
  const real = db.client();
  const denials: string[] = [];
  const client = {
    from: real.from.bind(real),
    rpc: (async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_bluesky_campaign_action") {
        const memberId = String(args.p_member_id);
        denials.push(memberId);

        // The winner's row is REAL: same workspace, same campaign, same
        // member, status `running`, no in-flight marker. That matters —
        // a fabricated id would be refused downstream for the wrong
        // reason and the test would pass without proving anything. This
        // row satisfies every check `consume` makes, so the only thing
        // standing between the loser and a duplicate follow is the
        // verdict it was handed.
        const actionId = `winner-action-${memberId}`;
        const actions = db.rows("bluesky_relationship_actions");
        if (!actions.some((a) => a.id === actionId)) {
          actions.push({
            id: actionId,
            workspace_id: WS,
            operator_account_id: IDENTITY,
            action_type: "follow",
            subject_did: `did:plc:s${memberId.slice(1)}`,
            status: "running",
            campaign_id: CAMPAIGN,
            campaign_run_id: db.rows("bluesky_follow_campaign_runs")[0]?.id ?? null,
            campaign_member_id: memberId,
            provider_in_flight_at: null,
            started_at: new Date(db.nowMs()).toISOString(),
            created_at: new Date(db.nowMs()).toISOString(),
          });
        }
        onClaim?.(memberId);
        return {
          data: [
            {
              action_id: actionId,
              may_mutate: false,
              needs_reconcile: false,
              terminal: false,
              existing_status: "running",
            },
          ],
          error: null,
        };
      }
      return real.rpc(fn, args);
    }) as unknown as typeof real.rpc,
  } as unknown as ReturnType<FakeDb["client"]>;
  return { client, denials };
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

const member = (db: FakeDb, id = "m1") =>
  db.rows("bluesky_follow_campaign_members").find((m) => m.id === id)!;
const run = (db: FakeDb) => db.rows("bluesky_follow_campaign_runs")[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a worker that loses the audit-row race", () => {
  it("sends nothing and spends nothing", async () => {
    const db = new FakeDb();
    seed(db, 1);
    const p = countingProvider();
    const loser = losesEveryClaim(db);

    await dispatch(db, p.impl, loser.client);

    expect(loser.denials.length).toBeGreaterThan(0);
    // THE assertion. The member belongs to another worker.
    expect(p.calls.createRecord).toBe(0);

    // And not a unit of quota was spent on it.
    expect(Number(run(db).attempted_count)).toBe(0);
    expect(
      db.rows("bluesky_campaign_attempt_ledger").filter((l) => l.provider_intent_at),
    ).toEqual([]);
    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(Number(usage?.attempts_made ?? 0)).toBe(0);
    expect(Number(usage?.follows_created ?? 0)).toBe(0);
  });

  it("does not touch a lease that now belongs to the winner", async () => {
    // The winner takes the member at the instant the claim is denied —
    // which is precisely the race. Everything the loser does from here
    // must leave that row alone.
    const db = new FakeDb();
    seed(db, 1);
    const p = countingProvider();

    let winnerSnapshot: Row | null = null;
    const loser = losesEveryClaim(db, (memberId) => {
      const m = member(db, memberId);
      m.claimed_by = "winner-worker";
      m.reservation_id = "winner-reservation";
      m.lease_expires_at = new Date(db.nowMs() + 300_000).toISOString();
      m.status = "running";
      winnerSnapshot = { ...m };
    });

    await dispatch(db, p.impl, loser.client);

    expect(p.calls.createRecord).toBe(0);
    expect(winnerSnapshot).not.toBeNull();

    const after = member(db);
    // Byte for byte what the winner left behind.
    expect(after.claimed_by).toBe("winner-worker");
    expect(after.reservation_id).toBe("winner-reservation");
    expect(after.status).toBe("running");
    expect(after.lease_expires_at).toBe(winnerSnapshot!.lease_expires_at);
    expect(after.attempt_count).toBe(winnerSnapshot!.attempt_count);
    expect(after.next_attempt_at ?? null).toBe(
      winnerSnapshot!.next_attempt_at ?? null,
    );
  });

  it("leaves the member recoverable once the lease lapses", async () => {
    // The denied member is NOT handed back. Returning it would put it
    // straight back in the queue for this same pass to reserve and be
    // denied on again — and a member another worker is mid-way through
    // is not ours to return in any case.
    //
    // Recoverability comes from the lease lapsing, which is the same
    // mechanism that recovers a member from a worker that died.
    const db = new FakeDb();
    seed(db, 1);
    const loser = losesEveryClaim(db);
    await dispatch(db, countingProvider().impl, loser.client);

    const held = member(db);
    expect(held.status).toBe("claimed");
    expect(held.lease_expires_at).toBeTruthy();
    expect(Number(held.attempt_count)).toBe(0);

    // Time passes, the lease lapses, and nobody finished it.
    for (const m of db.rows("bluesky_follow_campaign_members")) {
      m.lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
    }
    for (const r of db.rows("bluesky_campaign_quota_reservations")) {
      if (r.status === "open") {
        r.expires_at = new Date(db.nowMs() - 1000).toISOString();
      }
    }
    for (const r of db.rows("bluesky_follow_campaign_runs")) {
      r.dispatch_lease_expires_at = new Date(db.nowMs() - 1000).toISOString();
    }
    // The winner's audit row is gone too — it died without finishing.
    db.tables.set("bluesky_relationship_actions", []);

    const healthy = countingProvider();
    await dispatch(db, healthy.impl);
    expect(healthy.calls.createRecord).toBe(1);
    expect(member(db).status).toBe("succeeded");
  });

  it("a denied claim is NOT reconciliation — no note is written", async () => {
    // Reconciliation says "a request may have been sent and we must
    // find out". Nothing was sent on this worker's behalf and no
    // provider intent exists for it, so saying so would be a lie in the
    // operator's History.
    const db = new FakeDb();
    seed(db, 1);
    const loser = losesEveryClaim(db);
    await dispatch(db, countingProvider().impl, loser.client);

    const ours = db
      .rows("bluesky_relationship_actions")
      .filter((a) => a.campaign_member_id === "m1");
    // The loser never created one, and must not have edited the
    // winner's.
    for (const a of ours) {
      expect(a.reconciliation_note ?? null).toBeNull();
      expect(a.status).not.toBe("reconciliation_required");
    }
  });

  it("holds for a whole chunk, not just one member", async () => {
    const db = new FakeDb();
    seed(db, 12);
    const p = countingProvider();
    const loser = losesEveryClaim(db);

    await dispatch(db, p.impl, loser.client);

    expect(p.calls.createRecord).toBe(0);
    expect(Number(run(db).attempted_count)).toBe(0);
    expect(Number(run(db).succeeded_count)).toBe(0);
    // Nothing was invented in History either.
    // Only the winners' rows exist, untouched.
    const actions = db.rows("bluesky_relationship_actions");
    expect(actions).toHaveLength(12);
    for (const a of actions) {
      expect(a.status).toBe("running");
      expect(a.provider_in_flight_at ?? null).toBeNull();
    }
  });
});
