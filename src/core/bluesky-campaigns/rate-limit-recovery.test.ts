import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * A 429 whose reset falls LATER THE SAME DAY.
 *
 * Bluesky's write budget resets hourly, so a campaign that trips the
 * limit at 12:00 is allowed to continue at 13:00 — on the same local
 * day, against the same daily quota. The previous dispatcher returned
 * early on any run whose status was not `running`, which meant the
 * first 429 of the day forfeited every remaining follow until midnight.
 *
 * What the recovery must NOT do is more interesting than what it must:
 *
 *   - not open a second run for the day (that would double the budget);
 *   - not exceed the quota that remained when the limit was hit;
 *   - not resume one second before the provider said to;
 *   - not resurrect a run an operator paused.
 *
 * No real follow is performed: every provider call is a counted stub.
 */

const WS = "ws-1";
const CAMPAIGN = "camp-1";
const IDENTITY = "acct-1";
const ACTOR = "did:plc:operator";

/** 12:00 UTC — the limit is hit here. */
const NOON = "2026-09-11T12:00:00Z";
/** 13:00 UTC — the provider's reset. Same local day. */
const RESET_EPOCH = Math.floor(Date.parse("2026-09-11T13:00:00Z") / 1000);
/** 13:05 UTC — the next tick after the reset. Still the same local day. */
const AFTER_RESET = "2026-09-11T13:05:00Z";
/** 12:30 UTC — a tick BEFORE the reset. */
const BEFORE_RESET = "2026-09-11T12:30:00Z";

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

/**
 * Succeeds `limitAfter` times, then answers 429 with a reset header.
 * `reopen()` lifts the limit, standing in for the provider's own clock.
 */
function rateLimitingProvider(limitAfter: number) {
  const calls = { createRecord: 0, rejected: 0 };
  let limited = true;
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      if (limited && calls.createRecord >= limitAfter) {
        calls.rejected += 1;
        return json({ error: "RateLimitExceeded" }, 429, {
          "ratelimit-remaining": "0",
          "ratelimit-reset": String(RESET_EPOCH),
          "retry-after": "3600",
        });
      }
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
  return { impl, calls, reopen: () => { limited = false; } };
}

function seed(db: FakeDb, memberCount: number, campaign: Partial<Row> = {}): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "recovery",
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
      ...campaign,
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
}

const dispatch = (db: FakeDb, impl: typeof fetch, nowIso: string) => {
  // The fake's `now()` must be the instant the dispatcher is told it
  // is, or a deadline test silently measures the wall clock instead.
  db.setNow(nowIso);
  return dispatchCampaigns({
    nowIso,
    db: db.client(),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
};

const run = (db: FakeDb) => db.rows("bluesky_follow_campaign_runs")[0];
const campaign = (db: FakeDb) => db.rows("bluesky_follow_campaigns")[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a 429 that resets later the same day", () => {
  it("persists remaining / reset and schedules next_run_at no earlier than the reset", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const p = rateLimitingProvider(10);

    await dispatch(db, p.impl, NOON);

    expect(p.calls.rejected).toBeGreaterThan(0);
    const r = run(db);
    expect(r.status).toBe("rate_limited");
    // The metadata the provider handed us, durably stored — without it
    // the next tick has to guess when it is allowed to try again.
    expect(Number(r.rate_limit_remaining)).toBe(0);
    expect(r.rate_limit_reset_at).toBe(
      new Date(RESET_EPOCH * 1000).toISOString(),
    );
    expect(Date.parse(String(r.rate_limited_until))).toBe(RESET_EPOCH * 1000);

    const c = campaign(db);
    expect(Date.parse(String(c.rate_limited_until))).toBe(RESET_EPOCH * 1000);
    // Scheduled AT OR AFTER the reset, never before it.
    expect(Date.parse(String(c.next_run_at))).toBeGreaterThanOrEqual(
      RESET_EPOCH * 1000,
    );
  });

  it("does NOT resume before the reset, and sends nothing", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const p = rateLimitingProvider(10);
    await dispatch(db, p.impl, NOON);
    const followsBefore = p.calls.createRecord;

    p.reopen(); // the provider would accept writes — but we must not ask
    await dispatch(db, p.impl, BEFORE_RESET);

    expect(p.calls.createRecord).toBe(followsBefore);
    expect(run(db).status).toBe("rate_limited");
  });

  it("returns the SAME run to running after the reset and continues", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const p = rateLimitingProvider(10);

    await dispatch(db, p.impl, NOON);
    const runId = run(db).id;
    const attemptedAtLimit = Number(run(db).attempted_count);
    expect(run(db).status).toBe("rate_limited");

    p.reopen();
    await dispatch(db, p.impl, AFTER_RESET);

    // Same run — a second row would give the day a second quota.
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
    expect(run(db).id).toBe(runId);
    expect(Number(run(db).attempted_count)).toBeGreaterThan(attemptedAtLimit);
    // Work actually continued rather than merely being unblocked.
    expect(p.calls.createRecord).toBeGreaterThan(10);
    // The campaign is live again and no longer carries a limit window.
    expect(campaign(db).status).toBe("active");
    expect(campaign(db).rate_limited_until).toBeNull();
  });

  it("never exceeds the day's quota across the limit and the recovery", async () => {
    const db = new FakeDb();
    // 60 members, quota 100: the queue, not the quota, is the binding
    // constraint — so a recovery that forgot what the run had already
    // done would show up as more than 60 follows.
    seed(db, 60);
    const p = rateLimitingProvider(10);

    await dispatch(db, p.impl, NOON);
    p.reopen();
    await dispatch(db, p.impl, AFTER_RESET);
    await dispatch(db, p.impl, AFTER_RESET);

    expect(p.calls.createRecord).toBeLessThanOrEqual(60);
    expect(Number(run(db).attempted_count)).toBeLessThanOrEqual(100);
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
  });

  it("a quota already half spent before the 429 is NOT refilled by the recovery", async () => {
    const db = new FakeDb();
    seed(db, 400);
    const p = rateLimitingProvider(40);

    // Quota 100. Trip the limit after 40 follows.
    await dispatch(db, p.impl, NOON);
    expect(run(db).status).toBe("rate_limited");

    p.reopen();
    await dispatch(db, p.impl, AFTER_RESET);
    await dispatch(db, p.impl, AFTER_RESET);

    // The remaining allowance was 100 − what the run had spent. A
    // recovery that restarted the day's budget would land near 140.
    expect(p.calls.createRecord).toBeLessThanOrEqual(100);
    expect(Number(run(db).attempted_count)).toBeLessThanOrEqual(100);
  });

  it("does NOT resurrect a run the operator paused", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const p = rateLimitingProvider(10);
    await dispatch(db, p.impl, NOON);

    // Operator intervenes while the run sits rate-limited.
    run(db).status = "paused";
    const followsBefore = p.calls.createRecord;

    p.reopen();
    await dispatch(db, p.impl, AFTER_RESET);

    expect(run(db).status).toBe("paused");
    expect(p.calls.createRecord).toBe(followsBefore);
  });

  it("members held at the limit are released, not stranded in `claimed`", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const p = rateLimitingProvider(10);
    await dispatch(db, p.impl, NOON);

    // Whatever the chunk did not attempt must be back in the queue, or
    // the recovery has nothing to pick up and the reservation leaks.
    const members = db.rows("bluesky_follow_campaign_members");
    const stranded = members.filter(
      (m) => m.status === "claimed" || m.status === "running",
    );
    expect(stranded).toHaveLength(0);
    expect(Number(run(db).reserved_count)).toBe(0);
  });
});
