import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conservation,
  createFollowFixture,
  makeFollowCampaign,
  makeMembers,
  makeUnfollowCampaign,
  makeUnfollowMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchFairly, orderForFairness, tickDeadlineMs } from "./dispatch-round.server";
import { dispatchCampaigns } from "./dispatcher.server";
import { dispatchUnfollowCampaigns } from "@/core/bluesky-unfollow/dispatcher.server";

/**
 * Fairness across cron deliveries, on embedded PostgreSQL with the
 * shipped migrations, both dispatchers and both workers.
 *
 * THE CLOCK IS THE MODEL. `monotonicNowMs` is injected and advanced by
 * the provider double: every createRecord or deleteRecord costs 1,500 ms
 * (the 1,000 ms spacing floor plus 500 ms of latency), so a 20-member
 * chunk costs 30 s of "wall clock" without the test waiting for it.
 * With a 70 s delivery and a 35 s claim threshold that is exactly two
 * chunks per delivery, which is the regime that starved production.
 */

const NOW = "2026-09-16T12:00:00Z";
const DEADLINE = 70_000;

let f: FollowFixture;
let clock = 0;
const monotonic = () => clock;

beforeAll(async () => {
  f = await createFollowFixture("fair", { backend: "server" });
  await reconnectAccount(f, "jwt-NEW", "refresh-2");
}, 300_000);
afterAll(async () => { await f?.close(); });

// Campaigns from one test must not be due in the next, and the
// identity's day starts afresh: the tests share one identity and one
// usage date, and a test that spends 990 of its 1,000 actions would
// otherwise starve every test after it.
afterEach(async () => {
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'cancelled'
      where workspace_id = $1 and status <> 'cancelled'`,
    [f.tenant.workspaceId],
  );
  await f.db.query(
    `update public.bluesky_identity_daily_usage
        set attempts_made = 0, follows_created = 0,
            unfollows_deleted = 0, delete_attempts_made = 0
      where operator_account_id = $1`,
    [f.tenant.identityId],
  );
});

function double(unfollowDids: string[] = []) {
  return providerDouble({
    following: new Set(unfollowDids),
    createRecord: () => { clock += 1_500; return { status: 200 }; },
    deleteRecord: () => { clock += 1_500; return { status: 200 }; },
  });
}

async function setDue(campaignId: string, minutesAgo: number) {
  await f.db.query(
    `update public.bluesky_follow_campaigns set next_run_at = $2::timestamptz where id = $1`,
    [campaignId, new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString()],
  );
}

/** Three follow campaigns and one unfollow campaign, one identity, all due. */
async function seedFleet(members = 400) {
  const F1 = await makeFollowCampaign(f, "F1", { requestedDailyQuota: 300 });
  const F2 = await makeFollowCampaign(f, "F2", { requestedDailyQuota: 300 });
  const F3 = await makeFollowCampaign(f, "F3", { requestedDailyQuota: 300 });
  const U1 = await makeUnfollowCampaign(f, "U1", { requestedDailyQuota: 300 });
  await makeMembers(f, F1, members, `a${Math.random().toString(36).slice(2, 6)}`);
  await makeMembers(f, F2, members, `b${Math.random().toString(36).slice(2, 6)}`);
  await makeMembers(f, F3, members, `c${Math.random().toString(36).slice(2, 6)}`);
  const unfollowDids = await makeUnfollowMembers(f, U1, members, `u${Math.random().toString(36).slice(2, 6)}`);
  // The old scheduler orders by next_run_at: F1 is always earliest.
  await setDue(F1, 4); await setDue(F2, 3); await setDue(F3, 2); await setDue(U1, 1);
  return { F1, F2, F3, U1, unfollowDids };
}

const base = (p: ReturnType<typeof providerDouble>) => ({
  db: f.client,
  nowIso: NOW,
  fetchImpl: p.fetchImpl,
  sleep: async () => undefined,
  interRequestMs: 0,
  monotonicNowMs: monotonic,
  workspaceId: f.tenant.workspaceId,
});

// Each delivery is five minutes after the last, as the cron would have it.
let delivery = 0;
const fairTick = async (p: ReturnType<typeof providerDouble>, over: Record<string, unknown> = {}) => {
  clock = 0;
  delivery += 1;
  const nowIso = new Date(Date.parse(NOW) + delivery * 5 * 60_000).toISOString();
  return dispatchFairly({ ...base(p), nowIso, deadlineMs: DEADLINE, ...over });
};

const attempted = async (campaignId: string) =>
  Number(
    (await f.db.query<{ n: string }>(
      `select coalesce(sum(attempted_count), 0)::text as n
         from public.bluesky_follow_campaign_runs where campaign_id = $1`,
      [campaignId],
    )).rows[0].n,
  );

describe("bounded round-robin", () => {
  it("serves every due campaign in rotation across deliveries — at most one chunk each per round, persisted", async () => {
    const { F1, F2, F3, U1, unfollowDids } = await seedFleet();
    const p = double(unfollowDids);

    const sequence: string[][] = [];
    for (let t = 0; t < 4; t += 1) {
      const r = await fairTick(p);
      sequence.push(r.served.map((s) => s.campaignId));
    }
    // Two chunks per delivery; F1, F2 first (never served, follow
    // before unfollow among equals, then due order); then F3, U1;
    // then round again. The order comes from `last_dispatched_at`, so
    // it holds across four SEPARATE invocations.
    expect(sequence).toEqual([[F1, F2], [F3, U1], [F1, F2], [F3, U1]]);

    // Persisted state, not memory: every campaign carries its stamp.
    const stamps = await f.db.query<{ id: string; at: Date | null }>(
      `select id, last_dispatched_at as at from public.bluesky_follow_campaigns
        where id = any($1::uuid[])`, [[F1, F2, F3, U1]]);
    expect(stamps.rows.every((r) => r.at !== null)).toBe(true);

    // Each got exactly two chunks of twenty; the unfollow campaign got
    // its deletes; nobody got a third before everyone got a second.
    expect(await attempted(F1)).toBe(40);
    expect(await attempted(F2)).toBe(40);
    expect(await attempted(F3)).toBe(40);
    expect(await attempted(U1)).toBe(40);
    expect(p.calls.deleteRecord).toBe(40);
    expect(p.calls.createRecord).toBe(120);
  });

  it("NEGATIVE CONTROL — the previous shape (follow first, whole budget, no cap) starves later campaigns", async () => {
    const { F1, F2, F3, U1, unfollowDids } = await seedFleet();
    const p = double(unfollowDids);

    // Exactly what the route did before: the follow dispatcher with
    // the whole budget, then the unfollow dispatcher with the remainder
    // if more than 20 s was left. Same dispatchers, same database.
    for (let t = 1; t <= 4; t += 1) {
      clock = 0;
      const startedAt = clock;
      const nowIso = new Date(Date.parse(NOW) + t * 5 * 60_000).toISOString();
      await dispatchCampaigns({ ...base(p), nowIso, budgetMs: DEADLINE });
      const remainingMs = DEADLINE - (clock - startedAt);
      if (remainingMs > 20_000) {
        await dispatchUnfollowCampaigns({ ...base(p), nowIso, budgetMs: remainingMs });
      }
    }

    // The earliest-due follow campaign took every delivery — three
    // chunks each, the third started with ten seconds left. The other
    // two follow campaigns and the unfollow campaign never ran.
    expect(await attempted(F1)).toBeGreaterThanOrEqual(240);
    expect(await attempted(F2)).toBe(0);
    expect(await attempted(F3)).toBe(0);
    expect(await attempted(U1)).toBe(0);
    expect(p.calls.deleteRecord).toBe(0);
  });

  it("the ordering function itself: never-served first, then least recently served, follow before unfollow among equals", () => {
    const mk = (id: string, kind: "follow" | "unfollow", last: string | null, due: string | null) =>
      ({ id, kind, last_dispatched_at: last, next_run_at: due } as unknown as Parameters<typeof orderForFairness>[0][number]);
    const ordered = orderForFairness([
      mk("d", "follow", "2026-09-16T11:59:00Z", null),
      mk("c", "unfollow", null, "2026-09-16T11:00:00Z"),
      mk("b", "follow", null, "2026-09-16T11:30:00Z"),
      mk("a", "unfollow", "2026-09-16T11:50:00Z", null),
    ]).map((c) => c.id);
    expect(ordered).toEqual(["b", "c", "a", "d"]);
  });
});

describe("quota priority is separate from scheduling", () => {
  it("an unfollow campaign yields only when the identity's remaining budget is what the due follow campaigns still need", async () => {
    const F1 = await makeFollowCampaign(f, "F1 needs budget", { requestedDailyQuota: 300 });
    const U1 = await makeUnfollowCampaign(f, "U1 waits", { requestedDailyQuota: 300 });
    await makeMembers(f, F1, 200, "q");
    const unfollowDids = await makeUnfollowMembers(f, U1, 200, "qu");
    await setDue(F1, 2); await setDue(U1, 3); // U1 is due EARLIER
    // The identity has already spent 990 of its 1,000 actions today.
    await f.db.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date, follows_created, attempts_made)
       values ($1, $2, '2026-09-16', 990, 990)
       on conflict (workspace_id, operator_account_id, usage_date)
       do update set follows_created = 990, attempts_made = 990`,
      [f.tenant.workspaceId, f.tenant.identityId],
    );
    const p = double(unfollowDids);

    const r = await fairTick(p, { deadlineMs: 200_000 });
    const why = JSON.stringify({ served: r.served, deferred: r.deferred, notes: r.notes, follow: r.follow.notes, unfollow: r.unfollow.notes });
    // U1 was due first and would have been served first — but the 10
    // actions left are what F1 still needs, so it stood aside.
    expect(r.deferred.map((d) => d.campaignId), why).toContain(U1);
    expect(r.deferred.find((d) => d.campaignId === U1)?.reason).toMatch(/follow campaigns on this identity still need/);
    expect(r.served.map((s) => s.campaignId), why).toEqual([F1]);
    expect(p.calls.deleteRecord).toBe(0);
    expect(p.calls.createRecord).toBe(10);

    // With no follow campaign due, the same budget is the unfollow
    // campaign's to use.
    await f.db.query(`update public.bluesky_follow_campaigns set status = 'paused' where id = $1`, [F1]);
    await f.db.query(
      `update public.bluesky_identity_daily_usage set follows_created = 990, attempts_made = 990
        where operator_account_id = $1 and usage_date = '2026-09-16'`, [f.tenant.identityId]);
    const r2 = await fairTick(p, { deadlineMs: 200_000 });
    expect(r2.served.map((s) => s.campaignId)).toEqual([U1]);
    expect(p.calls.deleteRecord).toBe(10);
  });
});

describe("the deadline", () => {
  it("claims nothing when less than one chunk plus the settle margin remains", async () => {
    const { F1 } = await seedFleet(40);
    const p = double();
    const r = await fairTick(p, { deadlineMs: 20_000 });
    expect(r.served).toEqual([]);
    expect(r.notes.some((n) => /deadline/.test(n))).toBe(true);
    expect(await attempted(F1)).toBe(0);
    expect(p.calls.createRecord).toBe(0);
  });

  it("is conservative by default and bounded from the environment", () => {
    expect(tickDeadlineMs({})).toBe(55_000);
    expect(tickDeadlineMs({ BLUESKY_TICK_BUDGET_MS: "abc" })).toBe(55_000);
    expect(tickDeadlineMs({ BLUESKY_TICK_BUDGET_MS: "1000" })).toBe(55_000);
    expect(tickDeadlineMs({ BLUESKY_TICK_BUDGET_MS: "120000" })).toBe(120_000);
    expect(tickDeadlineMs({ BLUESKY_TICK_BUDGET_MS: "900000" })).toBe(240_000);
  });

  it("stops claiming mid-round rather than starting a chunk it cannot settle", async () => {
    const { F1, F2, F3, U1, unfollowDids } = await seedFleet(60);
    const p = double(unfollowDids);
    // 40 s: one chunk (30 s) fits, then 10 s is under the threshold.
    const r = await fairTick(p, { deadlineMs: 40_000 });
    expect(r.served.map((s) => s.campaignId)).toEqual([F1]);
    expect(r.deferred.map((d) => d.campaignId)).toEqual([F2, F3, U1]);
    expect(r.deferred.every((d) => d.reason === "deadline")).toBe(true);
  });
});

describe("an invocation that dies mid-chunk", () => {
  it("leaves the rotation persisted, loses no member, spends no unit twice", async () => {
    const F1 = await makeFollowCampaign(f, "F1 dies", { requestedDailyQuota: 300 });
    const F2 = await makeFollowCampaign(f, "F2 lives", { requestedDailyQuota: 300 });
    const U1 = await makeUnfollowCampaign(f, "U1 lives", { requestedDailyQuota: 300 });
    await makeMembers(f, F1, 60, "k");
    await makeMembers(f, F2, 60, "l");
    const unfollowDids = await makeUnfollowMembers(f, U1, 60, "ku");
    await setDue(F1, 3); await setDue(F2, 2); await setDue(U1, 1);

    // Delivery 1: the fifth follow request never returns — the
    // platform killed the process. The promise is abandoned; nothing
    // settles the chunk.
    let hung: string | null = null;
    const killer = providerDouble({
      following: new Set(unfollowDids),
      createRecord: ({ index, subjectDid }) => {
        clock += 1_500;
        if (index === 5) {
          hung = subjectDid;
          throw new HangSignal();
        }
        return { status: 200 };
      },
    });
    const hangingFetch: typeof fetch = async (url, init) => {
      try {
        return await killer.fetchImpl(url, init);
      } catch (err) {
        if (err instanceof HangSignal) return new Promise<Response>(() => undefined);
        throw err;
      }
    };
    clock = 0;
    const abandoned = dispatchFairly({ ...base(killer), fetchImpl: hangingFetch, deadlineMs: DEADLINE });
    await Promise.race([abandoned, new Promise((r) => setTimeout(r, 500))]);
    expect(hung).not.toBeNull();

    // What the dead process left behind: F1 touched, four members
    // done, one in flight, the rest leased. Time passes; leases lapse.
    const f1Stamp = (await f.db.query<{ at: Date | null }>(
      `select last_dispatched_at as at from public.bluesky_follow_campaigns where id = $1`, [F1])).rows[0].at;
    expect(f1Stamp).not.toBeNull();
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 second'
        where campaign_id = $1 and lease_expires_at is not null`, [F1]);
    await f.db.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 second'
        where campaign_id = $1 and status in ('open','held')`, [F1]);
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set dispatch_lease_expires_at = now() - interval '1 second'
        where campaign_id = $1`, [F1]);

    // The write that hung DID land at Bluesky: a later read reports it.
    const p2 = providerDouble({
      following: new Set<string>([...unfollowDids, hung!]),
      createRecord: () => { clock += 1_500; return { status: 200 }; },
      deleteRecord: () => { clock += 1_500; return { status: 200 }; },
    });

    // Delivery 2: F1 is at the BACK — its stamp is the newest — so the
    // survivors go first. Fairness did not depend on delivery 1 living.
    const r2 = await fairTick(p2);
    expect(r2.served.map((s) => s.campaignId)).toEqual([F2, U1]);

    // Keep delivering until everything is terminal.
    for (let t = 0; t < 12; t += 1) {
      const r = await fairTick(p2);
      if (r.served.length === 0) break;
    }
    for (const c of [F1, F2, U1]) {
      const cons = await conservation(f, c);
      expect(Number(cons.actionable_remaining), c).toBe(0);
      expect(Number(cons.open_leases)).toBe(0);
      expect(Number(cons.open_reservations)).toBe(0);
      expect(Number(cons.outstanding_intents)).toBe(0);
      expect(Number(cons.unresolved_actions)).toBe(0);
    }
    const f1 = await memberCounts(f, F1);
    // The hung member was reconciled by a READ, never re-sent.
    expect((f1.succeeded ?? 0) + (f1.already_following ?? 0)).toBe(60);
    expect(f1.already_following).toBe(1);
    // No member of F1 received two landed writes across both doubles.
    const landed = new Map<string, number>();
    for (const r of [...killer.createRecords, ...p2.createRecords]) {
      if (r.status === 200) landed.set(r.subjectDid, (landed.get(r.subjectDid) ?? 0) + 1);
    }
    expect([...landed.values()].every((n) => n === 1)).toBe(true);
    expect(landed.has(hung!)).toBe(false);
    // Every unfollow record deleted exactly once.
    const deleted = new Map<string, number>();
    for (const d of p2.deleteRecords) deleted.set(d.rkey, (deleted.get(d.rkey) ?? 0) + 1);
    expect([...deleted.values()].every((n) => n === 1)).toBe(true);
    expect(deleted.size).toBe(60);
  });
});

class HangSignal extends Error {}

describe("two deliveries at once", () => {
  it("are idempotent: disjoint chunks, no member attempted twice, both return", async () => {
    const F1 = await makeFollowCampaign(f, "F1 twice", { requestedDailyQuota: 300 });
    const F2 = await makeFollowCampaign(f, "F2 twice", { requestedDailyQuota: 300 });
    const U1 = await makeUnfollowCampaign(f, "U1 twice", { requestedDailyQuota: 300 });
    await makeMembers(f, F1, 100, "x");
    await makeMembers(f, F2, 100, "y");
    const unfollowDids = await makeUnfollowMembers(f, U1, 100, "xu");
    await setDue(F1, 3); await setDue(F2, 2); await setDue(U1, 1);
    const p = double(unfollowDids);

    clock = 0;
    const [a, b] = await Promise.all([
      dispatchFairly({ ...base(p), deadlineMs: 200_000 }),
      dispatchFairly({ ...base(p), deadlineMs: 200_000 }),
    ]);
    expect(a.served.length + b.served.length).toBeGreaterThan(0);

    const twice = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_follow_campaign_members
        where campaign_id = any($1::uuid[]) and attempt_count > 1`, [[F1, F2, U1]]);
    expect(Number(twice.rows[0].n)).toBe(0);
    const perDid = new Map<string, number>();
    for (const r of p.createRecords) perDid.set(r.subjectDid, (perDid.get(r.subjectDid) ?? 0) + 1);
    expect([...perDid.values()].every((n) => n === 1)).toBe(true);
    const perRkey = new Map<string, number>();
    for (const d of p.deleteRecords) perRkey.set(d.rkey, (perRkey.get(d.rkey) ?? 0) + 1);
    expect([...perRkey.values()].every((n) => n === 1)).toBe(true);
  });
});
