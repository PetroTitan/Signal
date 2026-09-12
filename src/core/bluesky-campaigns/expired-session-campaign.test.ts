import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * A campaign meeting an expired session mid-tick.
 *
 * The accounting is the point. Everything that must happen exactly once
 * happens BEFORE the provider call — the reservation unit is spent, the
 * attempt counted, the ledger's provider intent stamped, the audit row
 * marked in flight — so a refresh and a retry underneath must add a
 * second HTTP request and nothing else. Not a second unit, not a second
 * action row, not a second intent.
 *
 * Production response, verbatim:
 *     HTTP 400 {"error":"ExpiredToken","message":"Token has expired"}
 *
 * No real follow is performed: every provider call is a counted stub.
 */

const WS = "ws-1";
const CAMPAIGN = "camp-1";
const IDENTITY = "acct-1";
const ACTOR = "did:plc:operator";
const NOW = "2026-09-12T12:00:00Z";

const EXPIRED = { error: "ExpiredToken", message: "Token has expired" };

const counters = { refreshes: 0, createRecord: 0, consumeCalls: 0 };

/**
 * A client that counts calls to the quota RPC.
 *
 * The outcome assertions below would pass even if the retry called
 * `consume` a second time, because that RPC is idempotent per
 * (reservation, member) — it returns `already_consumed` and changes
 * nothing. That is a good property, but it is a SECOND line of defence.
 * The brief asks that the second HTTP request not consume again at all,
 * so this counts the calls rather than only their effect.
 */
function countingClient(db: FakeDb) {
  const real = db.client();
  return {
    from: real.from.bind(real),
    rpc: (async (fn: string, args: Record<string, unknown>) => {
      if (fn === "consume_bluesky_member_quota") counters.consumeCalls += 1;
      return real.rpc(fn, args);
    }) as unknown as typeof real.rpc,
  } as unknown as ReturnType<FakeDb["client"]>;
}
const tokens: string[] = [];

vi.mock("@/core/bluesky-relationships/session.server", () => ({
  resolveRelationshipSession: vi.fn(async () => {
    const renewed = {
      ok: true as const,
      actorDid: ACTOR,
      actorHandle: "op.bsky.social",
      accessJwt: "jwt-NEW",
      service: "https://bsky.social",
      connectionId: "conn",
      // The session a refresh returns refuses to refresh again — the
      // real one carries `refreshAllowed: false`.
      refreshOnce: async () => ({
        ok: false as const,
        code: "session_expired" as const,
        message: "Already refreshed once during this operation.",
      }),
    };
    return {
      ok: true as const,
      actorDid: ACTOR,
      actorHandle: "op.bsky.social",
      accessJwt: "jwt-OLD",
      service: "https://bsky.social",
      connectionId: "conn",
      refreshOnce: async () => {
        counters.refreshes += 1;
        return refreshSucceeds ? renewed : {
          ok: false as const,
          code: "session_expired" as const,
          message: "The Bluesky session expired and could not be renewed.",
        };
      },
    };
  }),
}));

let refreshSucceeds = true;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the first createRecord with the expired body, then succeeds. */
function providerExpiringOnce(failFirstN = 1) {
  const impl = (async (url: string, init?: RequestInit) => {
    if (url.includes("createRecord")) {
      counters.createRecord += 1;
      const raw = (init?.headers ?? {}) as Record<string, string>;
      const key = Object.keys(raw).find((k) => k.toLowerCase() === "authorization");
      tokens.push(String(key ? raw[key] : "").replace("Bearer ", ""));
      if (counters.createRecord <= failFirstN) return json(EXPIRED, 400);
      return json({
        uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${counters.createRecord}`,
        cid: "cid",
      });
    }
    if (url.includes("getRelationships")) {
      const others = new URL(url).searchParams.getAll("others");
      return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
    }
    return json({});
  }) as unknown as typeof fetch;
  return impl;
}

function seed(db: FakeDb, members: number): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "expired",
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
  const rows: Row[] = [];
  for (let i = 1; i <= members; i += 1) {
    rows.push({
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
  db.tables.set("bluesky_follow_campaign_members", rows);
  for (const t of [
    "bluesky_campaign_kill_switches",
    "bluesky_identity_daily_usage",
    "bluesky_follow_campaign_runs",
    "bluesky_relationship_actions",
    "bluesky_campaign_quota_reservations",
    "bluesky_campaign_attempt_ledger",
  ]) {
    db.tables.set(t, []);
  }
}

const dispatch = (db: FakeDb, impl: typeof fetch) => {
  db.setNow(NOW);
  return dispatchCampaigns({
    nowIso: NOW,
    db: countingClient(db),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
};

const run = (db: FakeDb) => db.rows("bluesky_follow_campaign_runs")[0];
const ledger = (db: FakeDb) => db.rows("bluesky_campaign_attempt_ledger");
const actions = (db: FakeDb) => db.rows("bluesky_relationship_actions");

beforeEach(() => {
  counters.refreshes = 0;
  counters.createRecord = 0;
  counters.consumeCalls = 0;
  tokens.length = 0;
  refreshSucceeds = true;
  vi.clearAllMocks();
});

describe("one member, expired session", () => {
  it("two HTTP calls but exactly one unit, one attempt and one intent", async () => {
    const db = new FakeDb();
    seed(db, 1);

    await dispatch(db, providerExpiringOnce());

    // Two provider calls, one refresh.
    expect(counters.createRecord).toBe(2);
    expect(counters.refreshes).toBe(1);
    expect(tokens).toEqual(["jwt-OLD", "jwt-NEW"]);

    // The retry did not ask for another unit. Two HTTP requests, ONE
    // consume call — not merely one net effect.
    expect(counters.consumeCalls).toBe(1);

    // THE accounting assertions. One of each, despite two requests.
    expect(Number(run(db).attempted_count)).toBe(1);
    expect(Number(run(db).succeeded_count)).toBe(1);

    const intents = ledger(db).filter((l) => l.provider_intent_at);
    expect(intents).toHaveLength(1);
    expect(ledger(db)).toHaveLength(1);

    expect(actions(db)).toHaveLength(1);
    expect(actions(db)[0].status).toBe("succeeded");

    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(Number(usage.attempts_made)).toBe(1);
    expect(Number(usage.follows_created)).toBe(1);

    // The member is finished, once.
    const members = db.rows("bluesky_follow_campaign_members");
    expect(members.filter((m) => m.status === "succeeded")).toHaveLength(1);
  });
});

describe("the rest of the tick reuses the refreshed session", () => {
  it("refreshes once for the whole chunk, not once per member", async () => {
    const db = new FakeDb();
    seed(db, 5);

    await dispatch(db, providerExpiringOnce());

    // 5 members + 1 retry = 6 calls, and ONE refresh.
    expect(counters.createRecord).toBe(6);
    expect(counters.refreshes).toBe(1);
    // Only the very first call carried the dead token.
    expect(tokens[0]).toBe("jwt-OLD");
    expect(tokens.slice(1).every((t) => t === "jwt-NEW")).toBe(true);

    // Five members, five consume calls — the retry added none.
    expect(counters.consumeCalls).toBe(5);

    // Five members, five units, five intents — not six.
    expect(Number(run(db).attempted_count)).toBe(5);
    expect(Number(run(db).succeeded_count)).toBe(5);
    expect(ledger(db).filter((l) => l.provider_intent_at)).toHaveLength(5);
    expect(actions(db)).toHaveLength(5);
  });
});

describe("when the refresh fails", () => {
  it("stops the campaign, attempts no later member, and needs reauthorization", async () => {
    refreshSucceeds = false;
    const db = new FakeDb();
    seed(db, 5);

    await dispatch(db, providerExpiringOnce(99));

    // One member reached the provider; the refresh failed; nothing
    // after it was tried.
    expect(counters.createRecord).toBe(1);
    expect(counters.refreshes).toBe(1);

    const campaign = db.rows("bluesky_follow_campaigns")[0];
    expect(campaign.status).toBe("reauthorization_required");

    // The one member that was attempted spent exactly one unit — the
    // failure does not refund it, because the request really was sent.
    expect(Number(run(db).attempted_count)).toBe(1);
    expect(ledger(db).filter((l) => l.provider_intent_at)).toHaveLength(1);

    // And no later member was touched.
    const untouched = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => Number(m.attempt_count) === 0 && m.status !== "succeeded");
    expect(untouched.length).toBeGreaterThanOrEqual(4);
  });
});

describe("what must not trigger a refresh", () => {
  it("403 is not retried and does not spend a refresh", async () => {
    const db = new FakeDb();
    seed(db, 1);
    const impl = (async (url: string) => {
      if (url.includes("createRecord")) {
        counters.createRecord += 1;
        return json({ error: "Forbidden", message: "nope" }, 403);
      }
      if (url.includes("getRelationships")) {
        const others = new URL(url).searchParams.getAll("others");
        return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
      }
      return json({});
    }) as unknown as typeof fetch;

    await dispatch(db, impl);

    expect(counters.createRecord).toBe(1);
    expect(counters.refreshes).toBe(0);
    // Still exactly one unit and one intent for the attempt made.
    expect(Number(run(db).attempted_count)).toBe(1);
    expect(ledger(db).filter((l) => l.provider_intent_at)).toHaveLength(1);
  });

  it("AccountTakedown is not retried and does not spend a refresh", async () => {
    const db = new FakeDb();
    seed(db, 1);
    const impl = (async (url: string) => {
      if (url.includes("createRecord")) {
        counters.createRecord += 1;
        return json({ error: "AccountTakedown", message: "taken down" }, 400);
      }
      if (url.includes("getRelationships")) {
        const others = new URL(url).searchParams.getAll("others");
        return json({ actor: ACTOR, relationships: others.map((d) => ({ did: d })) });
      }
      return json({});
    }) as unknown as typeof fetch;

    await dispatch(db, impl);

    expect(counters.createRecord).toBe(1);
    expect(counters.refreshes).toBe(0);
  });
});
