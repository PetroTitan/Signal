import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  actionsFor,
  assertConserved,
  campaignRow,
  createFollowFixture,
  identityState,
  identityUsage,
  intentsFor,
  leaveDeadLease,
  makeFollowCampaign,
  makeMembers,
  makeUnfollowCampaign,
  makeUnfollowMembers,
  markIdentityReauthorizationRequired,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  storedTokens,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";
import { dispatchFairly } from "./dispatch-round.server";
import { dispatchUnfollowCampaigns } from "@/core/bluesky-unfollow/dispatcher.server";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import { recoverReauthorizedCampaignsForConnectedIdentities } from "@/repositories/bluesky-campaign-repository";

/**
 * The identity-session coordinator, on the shipped migrations.
 *
 * One identity, many campaigns, one refresh. Every scenario runs the
 * real dispatchers, the real workers, the real session resolver and
 * the real coordinator RPCs; only the network is a double, and it
 * counts every request. No follow or unfollow is performed anywhere.
 *
 * Two-backend interleavings (a lease genuinely blocking a second
 * session) live in identity-session-two-session.pg.test.ts on embedded
 * PostgreSQL. This file is everything that one backend can prove.
 */

let f: FollowFixture;
const T0 = "2026-09-15T10:00:00Z";
const DAY = "2026-09-15";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

beforeAll(async () => {
  f = await createFollowFixture("coordinator");
}, 180_000);
afterAll(async () => { await f?.close(); });

// Campaigns from one scenario must not be due in the next, the identity
// must start each scenario connected on the dead pair, and its day
// must start afresh (the tests share one identity and one usage date).
afterEach(async () => {
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'cancelled'
      where workspace_id = $1 and status <> 'cancelled'`, [f.tenant.workspaceId]);
  await f.db.query(
    `update public.bluesky_identity_daily_usage
        set attempts_made = 0, follows_created = 0, unfollows_deleted = 0, delete_attempts_made = 0
      where operator_account_id = $1`, [f.tenant.identityId]);
  await f.db.query(
    `update public.platform_connections set refresh_lease_owner = null, refresh_lease_expires_at = null
      where id = $1`, [f.connectionId]);
});

const dispatch = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  dispatchCampaigns({
    nowIso: T0, db: f.client, fetchImpl, sleep: async () => undefined, interRequestMs: 0, ...over,
  });
const dispatchUnfollow = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  dispatchUnfollowCampaigns({
    nowIso: T0, db: f.client, fetchImpl, sleep: async () => undefined, interRequestMs: 0, ...over,
  });
const fair = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  dispatchFairly({
    nowIso: T0, db: f.client, fetchImpl, sleep: async () => undefined, interRequestMs: 0,
    deadlineMs: 600_000, chunkCostMs: 1, settleMarginMs: 0, workspaceId: f.tenant.workspaceId, ...over,
  });

const MIGRATION = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260917000002_identity_session_coordinator.sql"),
  "utf8",
);

describe("A — one campaign, expired access token, valid refresh token", () => {
  it("exactly one refresh; the same attempt retries once; one unit, one intent, one action; the run continues; generation +1; lease released", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const before = await identityState(f);
    const c = await makeFollowCampaign(f, "A", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 30, "ca");
    const provider = providerDouble({});

    await dispatch(provider.fetchImpl, { campaignId: c });

    expect(provider.calls.refreshSession).toBe(1);
    expect(provider.refreshTokensUsed).toEqual(["refresh-1"]);
    const refused = provider.createRecords.filter((r) => r.token === "jwt-OLD");
    expect(refused).toHaveLength(1);
    expect(provider.createRecords.filter((r) => r.subjectDid === refused[0].subjectDid)).toHaveLength(2);
    expect((await memberCounts(f, c)).succeeded).toBe(30);

    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(["running", "completed"]).toContain(runs[0].status);
    expect(Number(runs[0].attempted_count)).toBe(30);
    expect(await intentsFor(f, c)).toBe(30);
    expect((await actionsFor(f, c)).filter((a) => a.subject_did === refused[0].subjectDid)).toHaveLength(1);
    expect((await campaignRow(f, c)).status).toBe("completed");

    const after = await identityState(f);
    expect(after.status).toBe("connected");
    expect(after.health).toBe("healthy");
    expect(after.accountStatus).toBe("connected");
    expect(after.generation).toBe(before.generation + 1);
    expect(after.leaseOwner).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();
    const tokens = await storedTokens(f);
    expect(tokens.access).toBe("jwt-NEW");
    expect(tokens.refresh).toBe("refresh-2");
    // No token content anywhere in the row's metadata.
    expect(JSON.stringify(after.metadata)).not.toMatch(/jwt-|refresh-[12]/);
    await assertConserved(f, c, expect);
  });
});

describe("E — the current refresh credential is genuinely revoked", () => {
  it("one refresh attempt; the identity — not just one campaign — needs the operator; every active campaign stops; no further provider mutation; queue and progress unchanged", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-dead");
    const before = await identityState(f);
    const c1 = await makeFollowCampaign(f, "E1", { requestedDailyQuota: 100 });
    const c2 = await makeFollowCampaign(f, "E2", { requestedDailyQuota: 100 });
    const u1 = await makeUnfollowCampaign(f, "EU", { requestedDailyQuota: 100 });
    await makeMembers(f, c1, 20, "e1");
    await makeMembers(f, c2, 20, "e2");
    const unfollowDids = await makeUnfollowMembers(f, u1, 5, "eu");
    // c2 already has today's run, running — it is mid-day.
    await f.db.query(
      `select id from public.ensure_bluesky_campaign_run($1,$2,$3,100,100,null)`,
      [f.tenant.workspaceId, c2, DAY]);

    const provider = providerDouble({
      following: new Set(unfollowDids),
      refreshSession: () => ({ ok: false, status: 400, body: { error: "ExpiredToken", message: "Token has been revoked" } }),
    });
    const r1 = await dispatch(provider.fetchImpl, { campaignId: c1 });
    expect(r1.notes.join(" ")).toMatch(/reauthorization|rejected|identity/i);

    // ONE refresh, ONE refused write, then silence.
    expect(provider.calls.refreshSession).toBe(1);
    expect(provider.calls.createRecord).toBe(1);

    const id = await identityState(f);
    expect(id.status).toBe("reauthorization_required");
    expect(id.health).toBe("expired");
    expect(id.accountStatus).toBe("reauthorization_required");
    expect(id.generation).toBe(before.generation);
    expect(id.leaseOwner).toBeNull();

    // Every ACTIVE campaign on the identity stopped in the same
    // transaction — the sibling follow campaign and the unfollow
    // campaign too — and c2's running run is waiting, not paused.
    for (const c of [c1, c2, u1]) {
      const row = await campaignRow(f, c);
      expect(row.status, c).toBe("reauthorization_required");
      expect(row.last_error_code).toBe("reauthorization_required");
    }
    const c1runs = await runsFor(f, c1);
    expect(c1runs[0].status).toBe("waiting_for_auth");
    const c2runs = await runsFor(f, c2);
    expect(c2runs[0].status).toBe("waiting_for_auth");

    // Later ticks: no provider call for any of them, no state churn.
    for (let i = 1; i <= 3; i += 1) await fair(provider.fetchImpl, { nowIso: at(5 * i) });
    await dispatchUnfollow(provider.fetchImpl, { campaignId: u1, nowIso: at(20) });
    expect(provider.calls.createRecord).toBe(1);
    expect(provider.calls.deleteRecord).toBe(0);
    expect(provider.calls.refreshSession).toBe(1);

    // The refused member is retryable with a re-opened, marker-less action.
    const counts = await memberCounts(f, c1);
    expect(counts.retryable).toBe(1);
    expect(counts.queued).toBe(19);
    const a = await actionsFor(f, c1);
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe("pending");
    expect(a[0].provider_in_flight_at).toBeNull();
    expect(a[0].provider_error_code).toBe("ExpiredToken");

    // The operator reconnects (the App-Password route: new pair,
    // connected, then the recovery call it makes). EVERY campaign
    // comes back, the same runs resume, and the day continues with
    // ZERO refresh calls.
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, nowIso: at(30), db: f.client,
    });
    expect(recovered.map((r) => r.campaignId).sort()).toEqual([c1, c2, u1].sort());
    const afterId = await identityState(f);
    expect(afterId.generation).toBe(before.generation + 1); // the reconnect bumped it
    for (const c of [c1, c2, u1]) {
      const row = await campaignRow(f, c);
      expect(row.status, c).toBe("active");
      expect(row.last_error_code).toBeNull();
      expect(row.last_error_message).toBeNull();
    }
    expect((await runsFor(f, c1))[0].id).toBe(c1runs[0].id);
    expect((await runsFor(f, c1))[0].status).toBe("running");
    expect((await runsFor(f, c2))[0].status).toBe("running");

    await f.db.query(
      `update public.bluesky_follow_campaign_members set next_attempt_at = now() - interval '1 minute'
        where campaign_id = $1 and status = 'retryable'`, [c1]);
    const healthy = providerDouble({ following: new Set(unfollowDids) });
    await fair(healthy.fetchImpl, { nowIso: at(35) });
    expect(healthy.calls.refreshSession).toBe(0);
    expect((await memberCounts(f, c1)).succeeded).toBe(20);
    expect((await memberCounts(f, c2)).succeeded).toBe(20);
    expect((await memberCounts(f, u1)).succeeded).toBe(5);
    // The refused member: one real retry, the same action row, counted once.
    const e1 = healthy.createRecords.filter((r) => r.subjectDid === a[0].subject_did);
    expect(e1).toHaveLength(1);
    expect((await actionsFor(f, c1)).filter((x) => x.subject_did === a[0].subject_did)).toHaveLength(1);
    expect(Number((await runsFor(f, c1))[0].succeeded_count)).toBe(20);
    for (const c of [c1, c2, u1]) await assertConserved(f, c, expect);
  });
});

describe("a transient provider failure during the refresh", () => {
  it("changes nothing about the identity, leaves the run running and the campaign active, re-opens the member, and the next delivery refreshes", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const before = await identityState(f);
    const c = await makeFollowCampaign(f, "T", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 5, "tr");
    const flaky = providerDouble({
      refreshSession: () => { throw new Error("ECONNRESET"); },
    });
    const r = await dispatch(flaky.fetchImpl, { campaignId: c });
    expect(flaky.calls.refreshSession).toBe(1);
    expect(flaky.calls.createRecord).toBe(1);
    expect(r.notes.join(" ")).toMatch(/next delivery retries/);

    const id = await identityState(f);
    expect(id.status).toBe("connected");
    expect(id.accountStatus).toBe("connected");
    expect(id.generation).toBe(before.generation);
    expect(id.leaseOwner).toBeNull();
    expect((await campaignRow(f, c)).status).toBe("active");
    expect((await runsFor(f, c))[0].status).toBe("running");
    const a = await actionsFor(f, c);
    expect(a[0].status).toBe("pending");
    expect(a[0].provider_in_flight_at).toBeNull();
    expect((await memberCounts(f, c)).retryable).toBe(1);

    await f.db.query(
      `update public.bluesky_follow_campaign_members set next_attempt_at = now() - interval '1 minute'
        where campaign_id = $1 and status = 'retryable'`, [c]);
    const healthy = providerDouble({});
    await dispatch(healthy.fetchImpl, { campaignId: c, nowIso: at(5) });
    expect(healthy.calls.refreshSession).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(5);
    expect((await identityState(f)).generation).toBe(before.generation + 1);
    await assertConserved(f, c, expect);
  });
});

describe("crashes around the refresh", () => {
  it("owner crashed AFTER persisting (lease still held, newer generation stored): the next worker reloads and spends no provider refresh", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const stale = await resolveRelationshipSession({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, db: f.client,
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("unreachable");
    // The crashed owner committed the rotated pair and died holding its lease.
    await reconnectAccount(f, "jwt-NEW", "refresh-2");
    await leaveDeadLease(f, "refresh-dead-owner", 60);
    const provider = providerDouble({});
    const renewed = await stale.refreshOnce();
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error("unreachable");
    expect(renewed.accessJwt).toBe("jwt-NEW");
    expect(renewed.tokenGeneration).toBe(stale.tokenGeneration + 1);
    expect(provider.calls.refreshSession).toBe(0);
    // A reloaded session refuses a second refresh in the same operation.
    const again = await renewed.refreshOnce();
    expect(again.ok).toBe(false);
    expect(provider.calls.refreshSession).toBe(0);
  });

  it("owner crashed BEFORE the provider refresh: its lease expires and the next worker refreshes exactly once", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    await leaveDeadLease(f, "refresh-dead-owner", 1);
    const c = await makeFollowCampaign(f, "L", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 3, "le");
    const provider = providerDouble({});
    let waited = 0;
    const sleep = (ms: number) => { waited += ms; return new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))); };
    await dispatch(provider.fetchImpl, { campaignId: c, sleep });
    expect(waited).toBeGreaterThan(0);
    expect(provider.calls.refreshSession).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(3);
    expect((await identityState(f)).leaseOwner).toBeNull();
  });

  it("owner crashed AFTER the provider refresh but BEFORE persisting: the consumed token is refused, the identity waits for the operator, and reconnection recovers everything", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    await leaveDeadLease(f, "refresh-dead-owner", 1);
    const c = await makeFollowCampaign(f, "P", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 3, "pe");
    // refresh-1 was already spent by the dead worker: Bluesky refuses it.
    const provider = providerDouble({
      refreshSession: () => ({ ok: false, status: 400, body: { error: "ExpiredToken", message: "Token has been revoked" } }),
    });
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));
    await dispatch(provider.fetchImpl, { campaignId: c, sleep });
    expect(provider.calls.refreshSession).toBe(1);
    expect((await identityState(f)).status).toBe("reauthorization_required");
    expect((await campaignRow(f, c)).status).toBe("reauthorization_required");
    expect((await runsFor(f, c))[0].status).toBe("waiting_for_auth");
    // Reconnect → recovered → continues.
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, nowIso: at(10), db: f.client,
    });
    await f.db.query(
      `update public.bluesky_follow_campaign_members set next_attempt_at = now() - interval '1 minute'
        where campaign_id = $1 and status = 'retryable'`, [c]);
    const healthy = providerDouble({});
    await dispatch(healthy.fetchImpl, { campaignId: c, nowIso: at(15) });
    expect(healthy.calls.refreshSession).toBe(0);
    expect((await memberCounts(f, c)).succeeded).toBe(3);
    await assertConserved(f, c, expect);
  });
});

describe("an operator's pause is never undone by recovery", () => {
  it("a campaign paused while the identity waited stays paused; its sibling recovers", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-dead");
    const keep = await makeFollowCampaign(f, "keep", { requestedDailyQuota: 100 });
    const pause = await makeFollowCampaign(f, "pause", { requestedDailyQuota: 100 });
    await makeMembers(f, keep, 3, "kp");
    await makeMembers(f, pause, 3, "pz");
    const revoked = providerDouble({
      refreshSession: () => ({ ok: false, status: 400, body: { error: "ExpiredToken" } }),
    });
    await dispatch(revoked.fetchImpl, { campaignId: keep });
    expect((await campaignRow(f, pause)).status).toBe("reauthorization_required");
    // The operator presses Pause on `pause` while the identity waits.
    await f.db.query(
      `update public.bluesky_follow_campaigns set status = 'paused', paused_at = now(), next_run_at = null
        where id = $1 and status = 'reauthorization_required'`, [pause]);

    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, nowIso: at(10), db: f.client,
    });
    expect(recovered.map((r) => r.campaignId)).toEqual([keep]);
    expect((await campaignRow(f, keep)).status).toBe("active");
    expect((await campaignRow(f, pause)).status).toBe("paused");

    // The refused member's retry backoff is written in the database's
    // clock; the operator gets round to it later than that.
    await f.db.query(
      `update public.bluesky_follow_campaign_members set next_attempt_at = now() - interval '1 minute'
        where campaign_id = $1 and status = 'retryable'`, [keep]);
    const healthy = providerDouble({});
    for (let i = 1; i <= 3; i += 1) await fair(healthy.fetchImpl, { nowIso: at(10 + 5 * i) });
    expect((await campaignRow(f, pause)).status).toBe("paused");
    expect((await memberCounts(f, pause)).queued).toBe(3);
    expect(healthy.createRecords.filter((r) => r.subjectDid.startsWith("did:plc:pz"))).toHaveLength(0);
    expect((await memberCounts(f, keep)).succeeded).toBe(3);
  });
});

describe("follow and unfollow share ONE refresh", () => {
  it("a fair round over both kinds refreshes once; neither reverses or duplicates the other's mutation; no extra quota", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const fc = await makeFollowCampaign(f, "F", { requestedDailyQuota: 100 });
    const uc = await makeUnfollowCampaign(f, "U", { requestedDailyQuota: 100 });
    await makeMembers(f, fc, 12, "fs");
    const dids = await makeUnfollowMembers(f, uc, 12, "us");
    const provider = providerDouble({ following: new Set(dids) });

    const round = await fair(provider.fetchImpl);
    expect(provider.calls.refreshSession).toBe(1);
    expect(provider.refreshTokensUsed).toEqual(["refresh-1"]);
    expect((await memberCounts(f, fc)).succeeded).toBe(12);
    expect((await memberCounts(f, uc)).succeeded).toBe(12);
    // Each follow subject created exactly once; each unfollow rkey deleted exactly once.
    const created = provider.createRecords.filter((r) => r.status === 200).map((r) => r.subjectDid);
    expect(new Set(created).size).toBe(created.length);
    expect(created).toHaveLength(12);
    const deleted = provider.deleteRecords.filter((r) => r.status === 200).map((r) => r.rkey);
    expect(new Set(deleted).size).toBe(deleted.length);
    expect(deleted).toHaveLength(12);
    // Exactly one refused request across both kinds, retried once.
    expect(provider.createRecords.filter((r) => r.token === "jwt-OLD").length +
      provider.deleteRecords.filter((r) => r.token === "jwt-OLD").length).toBe(1);
    const usage = await identityUsage(f, DAY);
    expect(Number(usage.attempts_made)).toBe(24);
    expect(round.served.length).toBeGreaterThan(0);
    await assertConserved(f, fc, expect);
    await assertConserved(f, uc, expect);
  });
});

describe("five campaigns on one identity", () => {
  it("one refresh for the round; all five progress; the identity mirror agrees", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const c = await makeFollowCampaign(f, `five-f${i}`, { requestedDailyQuota: 100 });
      await makeMembers(f, c, 8, `v${i}`); ids.push(c);
    }
    const allDids: string[] = [];
    for (let i = 1; i <= 2; i += 1) {
      const u = await makeUnfollowCampaign(f, `five-u${i}`, { requestedDailyQuota: 100 });
      allDids.push(...(await makeUnfollowMembers(f, u, 8, `w${i}`))); ids.push(u);
    }
    const provider = providerDouble({ following: new Set(allDids) });
    await fair(provider.fetchImpl);
    expect(provider.calls.refreshSession).toBe(1);
    for (const c of ids) {
      expect((await memberCounts(f, c)).succeeded, c).toBe(8);
      await assertConserved(f, c, expect);
    }
    const id = await identityState(f);
    expect(id.status).toBe("connected");
    expect(id.accountStatus).toBe("connected");
  });
});

describe("a day boundary during the wait", () => {
  it("yesterday's waiting run is closed with its reason; today's run is created fresh; counters are not carried across days", async () => {
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    const c = await makeFollowCampaign(f, "day", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 4, "dy");
    const yday = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',100,100,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set status = 'waiting_for_auth', last_error_code = 'reauthorization_required', attempted_count = 7, succeeded_count = 7
        where id = $1`, [yday]);
    await f.db.query(
      `update public.bluesky_follow_campaigns set status = 'reauthorization_required', last_error_code = 'reauthorization_required' where id = $1`, [c]);

    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, nowIso: T0, db: f.client,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].runResumed).toBe(false);
    const provider = providerDouble({});
    await dispatch(provider.fetchImpl, { campaignId: c });
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(yday);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].effective_quota_reason).toMatch(/day ended while waiting/);
    expect(Number(runs[0].succeeded_count)).toBe(7);
    expect(Number(runs[1].attempted_count)).toBe(4);
    expect((await memberCounts(f, c)).succeeded).toBe(4);
  });
});

describe("the identity says connected but a campaign is still stopped (the state production was left in)", () => {
  it("the next delivery heals it with no probe and no Resume, then serves it", async () => {
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    const c = await makeFollowCampaign(f, "legacy", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 6, "lg");
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,$3,100,100,null)`,
      [f.tenant.workspaceId, c, DAY])).rows[0].id;
    await f.db.query(
      `update public.bluesky_follow_campaign_runs set status = 'paused', last_error_code = 'reauthorization_required', attempted_count = 2, succeeded_count = 2
        where id = $1`, [run]);
    await f.db.query(
      `update public.bluesky_follow_campaigns set status = 'reauthorization_required', last_error_code = 'reauthorization_required', next_run_at = $2
        where id = $1`, [c, at(-30)]);
    const provider = providerDouble({});
    const round = await fair(provider.fetchImpl);
    expect(round.follow.chunksProcessed).toBeGreaterThan(0);
    expect(provider.calls.getSession).toBe(0);
    expect(provider.calls.refreshSession).toBe(0);
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run);
    expect(Number(runs[0].attempted_count)).toBe(2 + 6);
    expect((await campaignRow(f, c)).last_dispatched_at).not.toBeNull();
  });
});

describe("privileges and lock order", () => {
  const RPCS = [
    "acquire_bluesky_refresh_lease",
    "release_bluesky_refresh_lease",
    "commit_bluesky_refreshed_session",
    "fail_bluesky_refresh",
    "recover_bluesky_reauthorized_campaigns",
    "stop_bluesky_campaigns_for_identity",
  ];
  it.each(RPCS)("%s — anon and authenticated cannot execute; service_role can", async (name) => {
    const r = await f.db.query<{ sig: string; auth: boolean; anon: boolean; svc: boolean }>(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [name]);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.auth, row.sig).toBe(false);
      expect(row.anon, row.sig).toBe(false);
      expect(row.svc, row.sig).toBe(true);
    }
  });

  it("no coordinator RPC returns a token column", async () => {
    const r = await f.db.query<{ proname: string; args: string; ret: string }>(
      `select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`, [RPCS]);
    for (const row of r.rows) {
      expect(row.ret, row.proname).not.toMatch(/token/i);
    }
  });

  it("the coordinator locks platform_connections → growth_accounts → campaigns → runs, and never a quota table", () => {
    const body = (name: string) => {
      const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
      const end = MIGRATION.indexOf("$$;", start);
      return MIGRATION.slice(start, end);
    };
    for (const name of ["commit_bluesky_refreshed_session", "fail_bluesky_refresh", "acquire_bluesky_refresh_lease"]) {
      const b = body(name);
      for (const table of [
        "bluesky_identity_daily_usage", "bluesky_campaign_quota_reservations",
        "bluesky_campaign_attempt_ledger", "bluesky_relationship_actions", "bluesky_follow_campaign_members",
      ]) {
        expect(b, `${name} must not touch ${table}`).not.toContain(table);
      }
    }
    const fail = body("fail_bluesky_refresh");
    expect(fail.indexOf("platform_connections")).toBeLessThan(fail.indexOf("growth_accounts"));
    expect(fail.indexOf("growth_accounts")).toBeLessThan(fail.indexOf("stop_bluesky_campaigns_for_identity("));
    const stop = body("stop_bluesky_campaigns_for_identity");
    expect(stop.indexOf("bluesky_follow_campaigns")).toBeLessThan(stop.indexOf("bluesky_follow_campaign_runs"));
    expect(stop).toMatch(/order by id\s+for update/);
    const commit = body("commit_bluesky_refreshed_session");
    expect(commit.indexOf("platform_connections")).toBeLessThan(commit.indexOf("growth_accounts"));
    expect(commit.indexOf("growth_accounts")).toBeLessThan(commit.indexOf("recover_bluesky_reauthorized_campaigns("));
  });

  it("the migration is idempotent", async () => {
    // Multi-statement: PGlite needs the simple protocol (`exec`).
    const raw = f.db as unknown as { exec?: (sql: string) => Promise<unknown> };
    if (raw.exec) await raw.exec(MIGRATION); else await f.db.query(MIGRATION);
    const col = await f.db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
        where table_name = 'platform_connections' and column_name in ('token_generation','refresh_lease_owner','refresh_lease_expires_at')`);
    expect(col.rows[0].n).toBe("3");
    const chk = await f.db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'bluesky_follow_campaign_runs_status_check'`);
    expect(chk.rows[0].def).toContain("waiting_for_auth");
  });

  it("the generation moves on ANY token write, never backwards, and the reauthorization state refuses a refresh at the same generation", async () => {
    const before = (await identityState(f)).generation;
    await f.db.query(`update public.platform_connections set access_token_encrypted = access_token_encrypted || '' where id = $1`, [f.connectionId]);
    expect((await identityState(f)).generation).toBe(before);
    await reconnectAccount(f, "jwt-X", "refresh-x");
    expect((await identityState(f)).generation).toBe(before + 1);
    await f.db.query(`update public.platform_connections set token_generation = 0 where id = $1`, [f.connectionId]);
    expect((await identityState(f)).generation).toBe(before + 1);

    await markIdentityReauthorizationRequired(f);
    const v = await f.db.query<{ verdict: string }>(
      `select verdict from public.acquire_bluesky_refresh_lease($1,$2,'probe',$3,30)`,
      [f.tenant.workspaceId, f.tenant.identityId, before + 1]);
    expect(v.rows[0].verdict).toBe("reauthorization_required");
    const stale = await f.db.query<{ verdict: string }>(
      `select verdict from public.acquire_bluesky_refresh_lease($1,$2,'probe',$3,30)`,
      [f.tenant.workspaceId, f.tenant.identityId, before]);
    expect(stale.rows[0].verdict).toBe("reload");
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
  });

  it("a stale failure — lease lost, or an older generation — never marks the identity", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const g = (await identityState(f)).generation;
    // No lease held: refused.
    let r = await f.db.query<{ applied: boolean; reason: string }>(
      `select applied, reason from public.fail_bluesky_refresh($1,$2,'nobody',$3,true,'x')`,
      [f.tenant.workspaceId, f.tenant.identityId, g]);
    expect(r.rows[0].applied).toBe(false);
    expect(r.rows[0].reason).toBe("lease_lost");
    // Older generation: refused, whoever holds the lease.
    await leaveDeadLease(f, "me", 60);
    r = await f.db.query<{ applied: boolean; reason: string }>(
      `select applied, reason from public.fail_bluesky_refresh($1,$2,'me',$3,true,'x')`,
      [f.tenant.workspaceId, f.tenant.identityId, g - 1]);
    expect(r.rows[0].applied).toBe(false);
    expect(r.rows[0].reason).toBe("generation_moved");
    expect((await identityState(f)).status).toBe("connected");
    expect((await identityState(f)).leaseOwner).toBeNull();
  });
});
