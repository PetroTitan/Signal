import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import { dispatchCampaigns } from "./dispatcher.server";
import { DAILY_QUOTA_OPTIONS } from "./quota";

/**
 * The dispatcher end to end, against a constraint-enforcing fake and a
 * scripted provider.
 *
 * NO REAL FOLLOW IS EVER PERFORMED. Every provider call in this file is
 * a stub; `createRecord` is counted, never sent.
 */

const WS = "ws-1";
const CAMPAIGN = "camp-1";
const IDENTITY = "acct-1";
const ACTOR = "did:plc:operator";
const NOW = "2026-09-11T12:00:00Z"; // inside a 00:00-24:00 UTC window

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

import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Script {
  createRecord?: (n: number) => Response;
  relationships?: (n: number) => Response;
}

function provider(script: Script = {}) {
  const calls = { createRecord: 0, relationships: 0 };
  const impl = (async (url: string) => {
    if (url.includes("createRecord")) {
      calls.createRecord += 1;
      return (
        script.createRecord?.(calls.createRecord) ??
        json({
          uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${calls.createRecord}`,
          cid: `cid${calls.createRecord}`,
        })
      );
    }
    if (url.includes("getRelationships")) {
      calls.relationships += 1;
      const u = new URL(url);
      const others = u.searchParams.getAll("others");
      return (
        script.relationships?.(calls.relationships) ??
        json({
          actor: ACTOR,
          relationships: others.map((did) => ({ did })),
        })
      );
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function seed(
  db: FakeDb,
  memberCount: number,
  campaign: Partial<Row> = {},
): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "Test campaign",
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
      ...campaign,
    },
  ]);
  const rows: Row[] = [];
  for (let i = 1; i <= memberCount; i += 1) {
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
  db.tables.set("bluesky_campaign_kill_switches", []);
  db.tables.set("bluesky_identity_daily_usage", []);
  db.tables.set("bluesky_follow_campaign_runs", []);
}

const run = (db: FakeDb, impl: typeof fetch, over: Record<string, unknown> = {}) => {
  // The RPC fake models Postgres `now()`. Keep it on the same instant
  // as the dispatcher; otherwise a retry scheduled from the injected
  // 2026 clock is already overdue against the machine's wall clock and
  // this pass reclaims it in a tight loop.
  db.setNow(NOW);
  return dispatchCampaigns({
    nowIso: NOW,
    db: db.client(),
    fetchImpl: impl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });
};

const members = (db: FakeDb) => db.rows("bluesky_follow_campaign_members");
const campaign = (db: FakeDb) => db.rows("bluesky_follow_campaigns")[0];
const runRow = (db: FakeDb) => db.rows("bluesky_follow_campaign_runs")[0];

beforeEach(() => {
  vi.mocked(resolveRelationshipSession).mockResolvedValue({
    ok: true,
    actorDid: ACTOR,
    actorHandle: "op.bsky.social",
    accessJwt: "jwt",
    service: "https://bsky.social",
    connectionId: "conn",
    refreshOnce: async () => ({
      ok: false,
      code: "session_expired",
      message: "no",
    }),
  } as never);
});

describe("a normal day", () => {
  it("follows up to the quota and stops", async () => {
    const db = new FakeDb();
    seed(db, 500, { requested_daily_quota: 100 });
    const p = provider();

    const result = await run(db, p.impl);

    expect(p.calls.createRecord).toBe(100);
    expect(result.succeeded).toBe(100);
    expect(members(db).filter((m) => m.status === "succeeded")).toHaveLength(100);
    expect(members(db).filter((m) => m.status === "queued")).toHaveLength(400);
    expect(runRow(db).succeeded_count).toBe(100);
  });

  it("persists the provider record identity for each follow", async () => {
    const db = new FakeDb();
    seed(db, 3, { requested_daily_quota: 100 });
    await run(db, provider().impl);
    for (const m of members(db)) {
      expect(m.status).toBe("succeeded");
      expect(String(m.provider_record_uri)).toContain("app.bsky.graph.follow");
      expect(m.provider_record_rkey).toBeTruthy();
      expect(m.provider_record_cid).toBeTruthy();
    }
  });

  it("leaves NO row in claimed or running after the tick", async () => {
    const db = new FakeDb();
    seed(db, 60, { requested_daily_quota: 40 });
    await run(db, provider().impl);
    const stuck = members(db).filter(
      (m) => m.status === "claimed" || m.status === "running",
    );
    expect(stuck).toEqual([]);
  });

  it("records the identity's consumption for the day", async () => {
    const db = new FakeDb();
    seed(db, 50, { requested_daily_quota: 30 });
    await run(db, provider().impl);
    const usage = db.rows("bluesky_identity_daily_usage")[0];
    expect(usage.follows_created).toBe(30);
  });
});

describe("every selectable quota", () => {
  it.each([...DAILY_QUOTA_OPTIONS])("attempts exactly %i", async (quota) => {
    const db = new FakeDb();
    seed(db, quota + 200, { requested_daily_quota: quota });
    const p = provider();
    await run(db, p.impl);
    expect(p.calls.createRecord).toBe(quota);
    expect(members(db).filter((m) => m.status === "succeeded")).toHaveLength(quota);
  });
});

describe("already-following costs no quota", () => {
  it("follows the rest of the quota instead of stopping short", async () => {
    const db = new FakeDb();
    seed(db, 100, { requested_daily_quota: 10 });
    // The first 20 DIDs are already followed.
    const p = provider({
      relationships: () => {
        const already = new Set(
          Array.from({ length: 20 }, (_, i) => `did:plc:s${i + 1}`),
        );
        return json({
          actor: ACTOR,
          relationships: [...already].map((did) => ({
            did,
            following: `at://${ACTOR}/app.bsky.graph.follow/pre`,
          })),
        });
      },
    });

    const result = await run(db, p.impl);

    // Quota is 10. The already-following ones consumed none of it, so
    // ten REAL follows still happened.
    expect(result.succeeded).toBe(10);
    expect(p.calls.createRecord).toBe(10);
    expect(members(db).filter((m) => m.status === "already_following").length).toBeGreaterThan(0);
    expect(runRow(db).succeeded_count).toBe(10);
  });
});

describe("401 — reauthorization required", () => {
  it("stops the campaign and does not keep trying", async () => {
    const db = new FakeDb();
    seed(db, 100, { requested_daily_quota: 100 });
    const p = provider({
      createRecord: () => json({ error: "ExpiredToken" }, 401),
    });

    await run(db, p.impl);

    expect(campaign(db).status).toBe("reauthorization_required");
    // One attempt, then stop. Retrying would only burn createSession
    // budget (300/day per account).
    expect(p.calls.createRecord).toBe(1);
    expect(members(db).filter((m) => m.status === "claimed")).toEqual([]);
  });

  it("a session that will not resolve stops the campaign before any call", async () => {
    const db = new FakeDb();
    seed(db, 10);
    vi.mocked(resolveRelationshipSession).mockResolvedValue({
      ok: false,
      code: "not_connected",
      message: "This Bluesky identity is not signed in.",
    } as never);
    const p = provider();

    await run(db, p.impl);

    expect(p.calls.createRecord).toBe(0);
    expect(campaign(db).status).toBe("reauthorization_required");
  });
});

describe("429 — rate limited", () => {
  it("stops the run, records the reset, and attempts nothing further", async () => {
    const db = new FakeDb();
    seed(db, 200, { requested_daily_quota: 200 });
    const resetAt = Math.floor(Date.now() / 1000) + 900;
    const p = provider({
      createRecord: (n) =>
        n >= 5
          ? json({ error: "RateLimitExceeded" }, 429, {
              "ratelimit-reset": String(resetAt),
              "ratelimit-remaining": "0",
            })
          : json({ uri: `at://${ACTOR}/app.bsky.graph.follow/3ok${n}`, cid: "c" }),
    });

    await run(db, p.impl);

    // Four succeeded, the fifth was refused, nothing after.
    expect(p.calls.createRecord).toBe(5);
    expect(runRow(db).status).toBe("rate_limited");
    expect(runRow(db).rate_limited_until).toBeTruthy();
    expect(new Date(String(runRow(db).rate_limited_until)).getTime()).toBe(
      resetAt * 1000,
    );
    // The refused member is retryable, not failed — it was never applied.
    const refused = members(db).find((m) => m.status === "retryable");
    expect(refused).toBeTruthy();
    expect(refused!.attempt_count).toBe(1);
  });

  it("does not attempt again while the reset is in the future", async () => {
    const db = new FakeDb();
    seed(db, 50, {
      requested_daily_quota: 50,
      rate_limited_until: new Date(Date.now() + 600_000).toISOString(),
    });
    const p = provider();
    await run(db, p.impl);
    expect(p.calls.createRecord).toBe(0);
  });
});

describe("transport failures and structural failures", () => {
  it("a 5xx is retryable and comes back with a backoff", async () => {
    const db = new FakeDb();
    seed(db, 5, { requested_daily_quota: 5, max_consecutive_failures: 100 });
    const p = provider({ createRecord: () => json({ error: "Boom" }, 503) });

    await run(db, p.impl);

    const retryable = members(db).filter((m) => m.status === "retryable");
    expect(retryable.length).toBeGreaterThan(0);
    for (const m of retryable) {
      expect(m.attempt_count).toBe(1);
      // A backoff is set, so the next tick does not immediately re-hit
      // a provider that is already struggling.
      expect(m.next_attempt_at).toBeTruthy();
      // Against the tick's own instant, not the machine's. Backoff is
      // computed from the injected `now` so every timestamp a pass
      // writes agrees with the rest of it.
      expect(new Date(String(m.next_attempt_at)).getTime()).toBeGreaterThan(
        Date.parse(NOW),
      );
    }
  });

  it("an unrecognised 4xx stops the campaign rather than retrying", async () => {
    const db = new FakeDb();
    seed(db, 50, { requested_daily_quota: 50 });
    const p = provider({
      createRecord: () => json({ error: "SomethingNew", message: "?" }, 422),
    });

    await run(db, p.impl);

    expect(campaign(db).status).toBe("failed");
    expect(p.calls.createRecord).toBe(1);
  });

  it("consecutive failures trip the circuit breaker", async () => {
    const db = new FakeDb();
    seed(db, 100, { requested_daily_quota: 100, max_consecutive_failures: 3 });
    const p = provider({ createRecord: () => json({ error: "Boom" }, 503) });

    await run(db, p.impl);

    // Three failures and it stops — not a hundred.
    expect(p.calls.createRecord).toBe(3);
    expect(runRow(db).status).toBe("paused");
  });
});

describe("dry run", () => {
  it("performs NO follow and creates no record", async () => {
    const db = new FakeDb();
    seed(db, 25, { requested_daily_quota: 25, dry_run: true });
    const p = provider();

    const result = await run(db, p.impl);

    // The one assertion that matters: zero provider mutations.
    expect(p.calls.createRecord).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(members(db).filter((m) => m.status === "succeeded")).toEqual([]);
    // Recorded as skipped, so a dry run cannot look like progress.
    expect(members(db).filter((m) => m.status === "skipped").length).toBeGreaterThan(0);
    expect(db.rows("bluesky_identity_daily_usage")[0]?.follows_created ?? 0).toBe(0);
  });
});

describe("kill switches", () => {
  it("the workspace-global switch stops everything", async () => {
    const db = new FakeDb();
    seed(db, 50);
    db.tables.set("bluesky_campaign_kill_switches", [
      { id: "k1", workspace_id: WS, operator_account_id: null, engaged: true,
        reason: "incident" },
    ]);
    const p = provider();
    await run(db, p.impl);
    expect(p.calls.createRecord).toBe(0);
  });

  it("the per-identity switch stops only that identity", async () => {
    const db = new FakeDb();
    seed(db, 50);
    db.tables.set("bluesky_campaign_kill_switches", [
      { id: "k1", workspace_id: WS, operator_account_id: IDENTITY, engaged: true,
        reason: "this account only" },
    ]);
    const p = provider();
    await run(db, p.impl);
    expect(p.calls.createRecord).toBe(0);
  });

  it("a released switch does not stop anything", async () => {
    const db = new FakeDb();
    seed(db, 10, { requested_daily_quota: 10 });
    db.tables.set("bluesky_campaign_kill_switches", [
      { id: "k1", workspace_id: WS, operator_account_id: null, engaged: false,
        reason: null },
    ]);
    const p = provider();
    await run(db, p.impl);
    expect(p.calls.createRecord).toBe(10);
  });

  it("the deploy-level env switch stops everything without a database read", async () => {
    const db = new FakeDb();
    seed(db, 10);
    const previous = process.env.BLUESKY_CAMPAIGNS_DISABLED;
    process.env.BLUESKY_CAMPAIGNS_DISABLED = "1";
    try {
      const p = provider();
      await run(db, p.impl);
      expect(p.calls.createRecord).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BLUESKY_CAMPAIGNS_DISABLED;
      else process.env.BLUESKY_CAMPAIGNS_DISABLED = previous;
    }
  });
});

describe("pause, resume and completion", () => {
  it("a paused campaign is never dispatched", async () => {
    const db = new FakeDb();
    seed(db, 50, { status: "paused" });
    const p = provider();
    const result = await run(db, p.impl);
    expect(result.campaignsConsidered).toBe(0);
    expect(p.calls.createRecord).toBe(0);
  });

  it("resuming continues the same queue without rebuilding it", async () => {
    const db = new FakeDb();
    seed(db, 60, { requested_daily_quota: 20 });
    await run(db, provider().impl);
    expect(members(db).filter((m) => m.status === "succeeded")).toHaveLength(20);

    // Operator pauses, then resumes.
    campaign(db).status = "paused";
    const paused = provider();
    await run(db, paused.impl);
    expect(paused.calls.createRecord).toBe(0);

    campaign(db).status = "active";
    campaign(db).requested_daily_quota = 20;

    // The next LOCAL DAY. After a day's quota is spent the campaign is
    // scheduled for tomorrow rather than five minutes from now, so
    // resuming means advancing the clock — which is what actually
    // happens, and what makes the frozen run for the previous day stay
    // frozen.
    const resumed = provider();
    await run(db, resumed.impl, { nowIso: "2026-09-12T12:00:00Z" });

    expect(resumed.calls.createRecord).toBe(20);
    // 40 done, 20 left — membership was never rebuilt.
    expect(members(db)).toHaveLength(60);
    expect(members(db).filter((m) => m.status === "succeeded")).toHaveLength(40);
  });

  it("completes exactly once when the queue is exhausted", async () => {
    const db = new FakeDb();
    seed(db, 10, { requested_daily_quota: 100 });
    await run(db, provider().impl);
    expect(campaign(db).status).toBe("completed");
    expect(campaign(db).completed_at).toBeTruthy();

    // A later tick must not re-complete or re-attempt.
    const after = provider();
    const result = await run(db, after.impl);
    expect(result.campaignsConsidered).toBe(0);
    expect(after.calls.createRecord).toBe(0);
  });

  it("a quota change affects only future work, not the running day", async () => {
    const db = new FakeDb();
    seed(db, 500, { requested_daily_quota: 100 });
    await run(db, provider().impl);
    const runId = runRow(db).id;
    expect(runRow(db).requested_daily_quota).toBe(100);
    expect(runRow(db).effective_daily_quota).toBe(100);

    // Operator raises the quota mid-day.
    campaign(db).requested_daily_quota = 400;

    const second = provider();
    await run(db, second.impl);

    // Today's frozen run keeps its quota, so the change did not widen
    // work already approved and counted for today.
    const today = db
      .rows("bluesky_follow_campaign_runs")
      .find((r) => r.id === runId)!;
    expect(today.requested_daily_quota).toBe(100);
  });
});

describe("the tick is bounded and resumable", () => {
  it("stops at its wall-clock budget and leaves the rest queued", async () => {
    const db = new FakeDb();
    seed(db, 1000, { requested_daily_quota: 1000 });
    const p = provider();
    let clock = 0;
    // Each call advances the fake clock; the budget runs out after a
    // couple of chunks.
    const result = await run(db, p.impl, {
      budgetMs: 100,
      monotonicNowMs: () => (clock += 40),
    });
    expect(p.calls.createRecord).toBeLessThan(1000);
    expect(members(db).filter((m) => m.status === "queued").length).toBeGreaterThan(0);
    expect(members(db).filter((m) => m.status === "claimed")).toEqual([]);
    expect(result.attempted).toBeGreaterThan(0);
  });
});

describe("this system cannot unfollow", () => {
  it("no dispatcher path issues a deleteRecord", async () => {
    const db = new FakeDb();
    seed(db, 50, { requested_daily_quota: 50 });
    let deletes = 0;
    const impl = (async (url: string) => {
      if (url.includes("deleteRecord")) deletes += 1;
      if (url.includes("createRecord")) {
        return json({ uri: `at://${ACTOR}/app.bsky.graph.follow/x`, cid: "c" });
      }
      return json({ actor: ACTOR, relationships: [] });
    }) as unknown as typeof fetch;

    await run(db, impl);
    expect(deletes).toBe(0);
  });
});
