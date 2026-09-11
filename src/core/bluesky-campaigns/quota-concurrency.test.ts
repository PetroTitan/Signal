import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import {
  countActionsNeedingReconciliation,
  listActionHistoryPage,
} from "@/repositories/bluesky-relationship-repository";
import { dispatchCampaigns } from "./dispatcher.server";
import { IDENTITY_DAILY_FOLLOW_CEILING } from "./quota";

/**
 * Two COMPLETE dispatchers, running concurrently.
 *
 * The previous test asserted that two workers claimed disjoint members.
 * That was true and insufficient: disjoint claims bound WHO touches
 * which row, not HOW MANY attempts happen in total. Two dispatchers
 * each read "0 used today", each computed the full quota, and each
 * proceeded — 200 follows against a quota of 100, with no member
 * followed twice.
 *
 * So the assertion here is on PROVIDER CALLS, which is the number that
 * reaches real people.
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

/** Counts createRecord calls. This is the number that matters. */
function countingProvider() {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return json({
        uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${calls.createRecord}`,
        cid: `cid${calls.createRecord}`,
      });
    }
    if (url.includes("getRelationships")) {
      calls.relationships += 1;
      const others = new URL(url).searchParams.getAll("others");
      return json({ actor: ACTOR, relationships: others.map((did) => ({ did })) });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function seed(
  db: FakeDb,
  memberCount: number,
  campaign: Partial<Row> = {},
  campaignId = CAMPAIGN,
  identityId = IDENTITY,
): void {
  const existing = db.tables.get("bluesky_follow_campaigns") ?? [];
  existing.push({
    id: campaignId,
    workspace_id: WS,
    operator_account_id: identityId,
    name: `campaign ${campaignId}`,
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
  });
  db.tables.set("bluesky_follow_campaigns", existing);

  const members = db.tables.get("bluesky_follow_campaign_members") ?? [];
  for (let i = 1; i <= memberCount; i += 1) {
    members.push({
      id: `${campaignId}-m${i}`,
      workspace_id: WS,
      campaign_id: campaignId,
      subject_did: `did:plc:${campaignId}-${i}`,
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

const dispatch = (db: FakeDb, impl: typeof fetch, over: Record<string, unknown> = {}) => {
  db.setNow(String(over.nowIso ?? NOW));
  return dispatchCampaigns({
    nowIso: NOW,
    db: db.client(),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });
};
beforeEach(() => {
  vi.clearAllMocks();
});

describe("two concurrent dispatchers cannot exceed the campaign quota", () => {
  it("provider calls stay at or below 100 for a quota of 100", async () => {
    const db = new FakeDb();
    seed(db, 1000, { requested_daily_quota: 100 });
    const p = countingProvider();

    // Two COMPLETE dispatcher passes, interleaved.
    await Promise.all([dispatch(db, p.impl), dispatch(db, p.impl)]);

    // THE assertion. Before the fix this was 200.
    expect(p.calls.createRecord).toBeLessThanOrEqual(100);
    expect(p.calls.createRecord).toBeGreaterThan(0);

    const run = db.rows("bluesky_follow_campaign_runs")[0];
    expect(run.succeeded_count).toBeLessThanOrEqual(100);
    // One run for the day, not two.
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
    // No member followed twice.
    const succeeded = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "succeeded");
    expect(new Set(succeeded.map((m) => m.id)).size).toBe(succeeded.length);
  });

  it("holds for four concurrent dispatchers", async () => {
    const db = new FakeDb();
    seed(db, 2000, { requested_daily_quota: 200 });
    const p = countingProvider();
    await Promise.all([
      dispatch(db, p.impl),
      dispatch(db, p.impl),
      dispatch(db, p.impl),
      dispatch(db, p.impl),
    ]);
    expect(p.calls.createRecord).toBeLessThanOrEqual(200);
  });

  it("a sequential second pass on the same day adds nothing beyond the quota", async () => {
    const db = new FakeDb();
    seed(db, 500, { requested_daily_quota: 100 });
    const p = countingProvider();
    await dispatch(db, p.impl);
    const afterFirst = p.calls.createRecord;
    await dispatch(db, p.impl);
    expect(afterFirst).toBe(100);
    // The day is spent; a later tick must not top it up.
    expect(p.calls.createRecord).toBe(100);
  });

  it("the reservation is fully released — the day does not silently shrink", async () => {
    const db = new FakeDb();
    seed(db, 60, { requested_daily_quota: 100 });
    await dispatch(db, countingProvider().impl);
    const run = db.rows("bluesky_follow_campaign_runs")[0];
    // Every reservation was either attempted or given back.
    expect(run.reserved_count).toBe(0);
    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(usage.reserved_count).toBe(0);
  });
});

describe("two concurrent dispatchers cannot exceed the per-identity ceiling", () => {
  it("two campaigns sharing an identity stay within its combined allowance", async () => {
    const db = new FakeDb();
    // Each campaign asks for 1000; the identity's ceiling is 1000 TOTAL.
    seed(db, 2000, { requested_daily_quota: 1000 }, "camp-a", IDENTITY);
    seed(db, 2000, { requested_daily_quota: 1000 }, "camp-b", IDENTITY);
    // seed() resets these tables, so re-clear after the second call.
    db.tables.set("bluesky_identity_daily_usage", []);
    db.tables.set("bluesky_follow_campaign_runs", []);

    const p = countingProvider();
    await Promise.all([dispatch(db, p.impl), dispatch(db, p.impl)]);

    expect(p.calls.createRecord).toBeLessThanOrEqual(
      IDENTITY_DAILY_FOLLOW_CEILING,
    );
    const usage = db.rows("bluesky_identity_daily_usage");
    expect(usage).toHaveLength(1);
    expect(Number(usage[0].follows_created)).toBeLessThanOrEqual(
      IDENTITY_DAILY_FOLLOW_CEILING,
    );
  }, 60_000);

  it("an identity already near its ceiling gets only the remainder", async () => {
    const db = new FakeDb();
    seed(db, 500, { requested_daily_quota: 1000 });
    db.tables.set("bluesky_identity_daily_usage", [
      {
        id: "u1",
        workspace_id: WS,
        operator_account_id: IDENTITY,
        usage_date: "2026-09-11",
        follows_created: IDENTITY_DAILY_FOLLOW_CEILING - 25,
        attempts_made: IDENTITY_DAILY_FOLLOW_CEILING - 25,
        reserved_count: 0,
      },
    ]);
    const p = countingProvider();
    await dispatch(db, p.impl);
    expect(p.calls.createRecord).toBeLessThanOrEqual(25);
  });
});

describe("counters are deltas, not absolutes from a stale snapshot", () => {
  it("concurrent passes do not lose each other's increments", async () => {
    const db = new FakeDb();
    seed(db, 1000, { requested_daily_quota: 100 });
    const p = countingProvider();
    await Promise.all([dispatch(db, p.impl), dispatch(db, p.impl)]);

    const run = db.rows("bluesky_follow_campaign_runs")[0];
    const succeededMembers = db
      .rows("bluesky_follow_campaign_members")
      .filter((m) => m.status === "succeeded").length;

    // With absolute writes from a snapshot, the second writer would
    // clobber the first and this would come out lower than the member
    // count.
    expect(Number(run.succeeded_count)).toBe(succeededMembers);
    expect(Number(run.succeeded_count)).toBe(p.calls.createRecord);
  });

  it("identity usage equals the follows actually created", async () => {
    const db = new FakeDb();
    seed(db, 300, { requested_daily_quota: 100 });
    const p = countingProvider();
    await Promise.all([dispatch(db, p.impl), dispatch(db, p.impl)]);
    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(Number(usage.follows_created)).toBe(p.calls.createRecord);
  });
});

describe("campaign work is visible in History", () => {
  it("every attempted member gets a linked audit row", async () => {
    // The worker previously never inserted one, so the campaign-member
    // unique index guarded an empty set and History showed nothing.
    const db = new FakeDb();
    seed(db, 25, { requested_daily_quota: 25 });
    const p = countingProvider();
    await dispatch(db, p.impl);

    const actions = db.rows("bluesky_relationship_actions");
    expect(actions.length).toBe(p.calls.createRecord);
    for (const a of actions) {
      expect(a.campaign_id).toBe(CAMPAIGN);
      expect(a.campaign_run_id).toBeTruthy();
      expect(a.campaign_member_id).toBeTruthy();
      expect(a.action_type).toBe("follow");
      expect(a.status).toBe("succeeded");
      // The in-flight marker is cleared on every terminal path.
      expect(a.provider_in_flight_at).toBeNull();
      // The provider record identity is preserved for the audit.
      expect(String(a.follow_uri)).toContain("app.bsky.graph.follow");
      expect(a.follow_rkey).toBeTruthy();
    }
  });

  it("the History READ PATH returns them, not just the table", async () => {
    // Asserting on raw rows proves the insert happened; it does not
    // prove the operator can see it. History scopes by workspace AND
    // operator account and orders by requested_at — a campaign row that
    // missed either column would be invisible in the UI while looking
    // perfectly correct in the table.
    const db = new FakeDb();
    seed(db, 12, { requested_daily_quota: 12 });
    const p = countingProvider();
    await dispatch(db, p.impl);

    const history = await listActionHistoryPage({
      workspaceId: WS,
      operatorAccountId: IDENTITY,
      db: db.client(),
    });

    expect(history.total).toBe(p.calls.createRecord);
    expect(history.rows.length).toBe(p.calls.createRecord);
    for (const row of history.rows) {
      expect(row.campaign_id).toBe(CAMPAIGN);
      expect(row.action_type).toBe("follow");
    }

    // And the reconciliation banner counts zero on a clean run.
    await expect(
      countActionsNeedingReconciliation({
        workspaceId: WS,
        operatorAccountId: IDENTITY,
        db: db.client(),
      }),
    ).resolves.toBe(0);
  });

  it("one action per member — never two", async () => {
    const db = new FakeDb();
    seed(db, 40, { requested_daily_quota: 40 });
    const p = countingProvider();
    await Promise.all([dispatch(db, p.impl), dispatch(db, p.impl)]);
    const actions = db.rows("bluesky_relationship_actions");
    const byMember = new Set(actions.map((a) => a.campaign_member_id));
    expect(byMember.size).toBe(actions.length);
  });
});
