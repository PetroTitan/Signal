import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
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
import { recoverReauthorizedCampaignsForConnectedIdentities } from "@/repositories/bluesky-campaign-repository";

/**
 * Two REAL PostgreSQL sessions contending for one identity's refresh.
 *
 * PGlite runs a single backend, so a lease can never be observed
 * blocking a second worker there. Embedded PostgreSQL runs real
 * backends behind a small pool: two dispatchers really do run at once,
 * `for update` really blocks, and the interleaving below is the one
 * production saw — two campaigns on @webmasterid.bsky.social meeting
 * the same expired access token.
 *
 * THE GATE. The provider double answers the refresh only after BOTH
 * workers have been refused with the old token. That forces the
 * interleaving the brief names: A acquires the lease and is held at the
 * provider; B is refused, finds the lease busy, waits; A commits; B is
 * told to reload and continues on A's generation. One refresh, ever.
 */

let f: FollowFixture;
const T0 = "2026-09-15T13:00:00Z";
const DAY = "2026-09-15";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));

beforeAll(async () => {
  f = await createFollowFixture("coord-2s", { backend: "server" });
}, 300_000);
afterAll(async () => { await f?.close(); });
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

const base = (fetchImpl: typeof fetch) => ({
  nowIso: T0, db: f.client, fetchImpl, sleep: realSleep, interRequestMs: 0,
});

/** A provider whose refresh is held until `refusedOld` workers have met the dead token. */
function gatedProvider(refusedOldNeeded: number, script: Parameters<typeof providerDouble>[0] = {}) {
  const inner = providerDouble(script);
  let refusedOld = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const events: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const token = new Headers(init?.headers ?? {}).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if ((href.includes("createRecord") || href.includes("deleteRecord")) && token === "jwt-OLD") {
      refusedOld += 1;
      events.push(`refused:${refusedOld}`);
      if (refusedOld >= refusedOldNeeded) release();
    }
    if (href.includes("refreshSession")) {
      events.push("refresh:wait");
      await gate;
      events.push("refresh:go");
    }
    return inner.fetchImpl(url, init);
  }) as typeof fetch;
  return { inner, fetchImpl, events };
}

describe("B — two campaigns, one identity, the same expired access token, two real sessions", () => {
  it("exactly one provider refresh; the loser reloads; both continue; no duplicate follow; no extra quota, intent or action; no reauthorization", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const before = await identityState(f);
    const A = await makeFollowCampaign(f, "webmasterid-auto-300", { requestedDailyQuota: 100 });
    const B = await makeFollowCampaign(f, "WebmasterID 1-3", { requestedDailyQuota: 100 });
    await makeMembers(f, A, 15, "ta");
    await makeMembers(f, B, 15, "tb");
    const p = gatedProvider(2);

    const [ra, rb] = await Promise.all([
      dispatchCampaigns({ ...base(p.fetchImpl), campaignId: A }),
      dispatchCampaigns({ ...base(p.fetchImpl), campaignId: B }),
    ]);

    // The interleaving really happened: both were refused before the
    // one refresh was answered.
    expect(p.events.slice(0, 3).sort()).toEqual(["refresh:wait", "refused:1", "refused:2"].sort());
    expect(p.inner.calls.refreshSession).toBe(1);
    expect(p.inner.refreshTokensUsed).toEqual(["refresh-1"]);

    for (const [c, r] of [[A, ra], [B, rb]] as const) {
      expect(r.notes.join(" "), c).not.toMatch(/reauthorization/i);
      expect((await memberCounts(f, c)).succeeded, c).toBe(15);
      expect((await campaignRow(f, c)).status, c).toBe("completed");
      expect(await intentsFor(f, c), c).toBe(15);
      const runs = await runsFor(f, c);
      expect(runs).toHaveLength(1);
      expect(Number(runs[0].attempted_count)).toBe(15);
      expect(Number(runs[0].succeeded_count)).toBe(15);
      expect((await actionsFor(f, c)).length).toBe(15);
      await assertConserved(f, c, expect);
    }
    // Each subject followed exactly once; exactly two refusals (one per worker).
    const ok = p.inner.createRecords.filter((r) => r.status === 200).map((r) => r.subjectDid);
    expect(new Set(ok).size).toBe(30);
    expect(p.inner.createRecords.filter((r) => r.token === "jwt-OLD")).toHaveLength(2);
    expect(p.inner.createRecords.filter((r) => r.token === "jwt-NEW")).toHaveLength(30);
    const usage = await identityUsage(f, DAY);
    expect(Number(usage.attempts_made)).toBe(30);
    expect(Number(usage.follows_created)).toBe(30);

    const after = await identityState(f);
    expect(after.status).toBe("connected");
    expect(after.accountStatus).toBe("connected");
    expect(after.generation).toBe(before.generation + 1);
    expect(after.leaseOwner).toBeNull();
    expect((await storedTokens(f)).refresh).toBe("refresh-2");
  });

  it("a follow and an unfollow worker meeting the same expiry share the one refresh and never touch each other's records", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const fc = await makeFollowCampaign(f, "F", { requestedDailyQuota: 100 });
    const uc = await makeUnfollowCampaign(f, "U", { requestedDailyQuota: 100 });
    await makeMembers(f, fc, 10, "fx");
    const dids = await makeUnfollowMembers(f, uc, 10, "ux");
    const p = gatedProvider(2, { following: new Set(dids) });

    await Promise.all([
      dispatchCampaigns({ ...base(p.fetchImpl), campaignId: fc }),
      dispatchUnfollowCampaigns({ ...base(p.fetchImpl), campaignId: uc }),
    ]);
    expect(p.inner.calls.refreshSession).toBe(1);
    expect((await memberCounts(f, fc)).succeeded).toBe(10);
    expect((await memberCounts(f, uc)).succeeded).toBe(10);
    const created = p.inner.createRecords.filter((r) => r.status === 200).map((r) => r.subjectDid);
    expect(new Set(created).size).toBe(10);
    const deleted = p.inner.deleteRecords.filter((r) => r.status === 200).map((r) => r.rkey);
    expect(new Set(deleted).size).toBe(10);
    expect(Number((await identityUsage(f, DAY)).attempts_made)).toBe(20);
    expect((await identityState(f)).status).toBe("connected");
  });

  it("at-least-once cron: two simultaneous fair deliveries over the same campaigns — one refresh, one chunk per member, nothing doubled", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const A = await makeFollowCampaign(f, "dupA", { requestedDailyQuota: 100 });
    const B = await makeFollowCampaign(f, "dupB", { requestedDailyQuota: 100 });
    await makeMembers(f, A, 10, "da");
    await makeMembers(f, B, 10, "db");
    const p = gatedProvider(1);
    const tick = () => dispatchFairly({
      ...base(p.fetchImpl), deadlineMs: 600_000, chunkCostMs: 1, settleMarginMs: 0,
      workspaceId: f.tenant.workspaceId,
    });
    await Promise.all([tick(), tick()]);
    expect(p.inner.calls.refreshSession).toBeLessThanOrEqual(1);
    const ok = p.inner.createRecords.filter((r) => r.status === 200).map((r) => r.subjectDid);
    expect(new Set(ok).size).toBe(ok.length);
    // A second delivery finishes whatever the first left.
    await tick();
    expect((await memberCounts(f, A)).succeeded).toBe(10);
    expect((await memberCounts(f, B)).succeeded).toBe(10);
    expect(p.inner.calls.refreshSession).toBe(1);
    expect(Number((await identityUsage(f, DAY)).follows_created)).toBe(20);
    await assertConserved(f, A, expect);
    await assertConserved(f, B, expect);
  });
});

describe("crashes, on real backends", () => {
  it("the owner died before calling the provider: the waiting worker is blocked by the lease, then refreshes once after it lapses", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    await leaveDeadLease(f, "refresh-dead", 2);
    const c = await makeFollowCampaign(f, "lapse", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 5, "lp");
    const p = providerDouble({});
    const started = Date.now();
    await dispatchCampaigns({ ...base(p.fetchImpl), campaignId: c });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(p.calls.refreshSession).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(5);
    expect((await identityState(f)).leaseOwner).toBeNull();
  });

  it("the owner died after the provider rotated but before persisting: the consumed token is refused once, every campaign waits, reconnection recovers all", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    await leaveDeadLease(f, "refresh-dead", 1);
    const A = await makeFollowCampaign(f, "lostA", { requestedDailyQuota: 100 });
    const B = await makeFollowCampaign(f, "lostB", { requestedDailyQuota: 100 });
    await makeMembers(f, A, 5, "la");
    await makeMembers(f, B, 5, "lb");
    const p = gatedProvider(2, {
      refreshSession: () => ({ ok: false, status: 400, body: { error: "ExpiredToken", message: "Token has been revoked" } }),
    });
    await Promise.all([
      dispatchCampaigns({ ...base(p.fetchImpl), campaignId: A }),
      dispatchCampaigns({ ...base(p.fetchImpl), campaignId: B }),
    ]);
    // One refresh attempt for the identity, however many workers.
    expect(p.inner.calls.refreshSession).toBe(1);
    expect(p.inner.calls.createRecord).toBe(2);
    expect((await identityState(f)).status).toBe("reauthorization_required");
    expect((await campaignRow(f, A)).status).toBe("reauthorization_required");
    expect((await campaignRow(f, B)).status).toBe("reauthorization_required");
    for (const c of [A, B]) expect((await runsFor(f, c))[0].status).toBe("waiting_for_auth");

    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, nowIso: at(10), db: f.client,
    });
    await f.db.query(
      `update public.bluesky_follow_campaign_members set next_attempt_at = now() - interval '1 minute'
        where campaign_id in ($1, $2) and status = 'retryable'`, [A, B]);
    const healthy = providerDouble({});
    await dispatchFairly({
      ...base(healthy.fetchImpl), nowIso: at(15), deadlineMs: 600_000, chunkCostMs: 1, settleMarginMs: 0,
      workspaceId: f.tenant.workspaceId,
    });
    expect(healthy.calls.refreshSession).toBe(0);
    expect((await memberCounts(f, A)).succeeded).toBe(5);
    expect((await memberCounts(f, B)).succeeded).toBe(5);
    for (const c of [A, B]) {
      const runs = await runsFor(f, c);
      expect(runs).toHaveLength(1);
      await assertConserved(f, c, expect);
    }
  });

  it("reconnect DURING an active tick: the worker's stale session meets ExpiredToken, reloads the reconnected generation, spends no refresh", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const c = await makeFollowCampaign(f, "mid", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 6, "md");
    const inner = providerDouble({});
    let reconnected = false;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      // The operator's reconnect lands while this worker is mid-chunk.
      if (String(url).includes("createRecord") && !reconnected) {
        reconnected = true;
        await reconnectAccount(f, "jwt-NEW", "refresh-2");
      }
      return inner.fetchImpl(url, init);
    }) as typeof fetch;
    await dispatchCampaigns({ ...base(fetchImpl), campaignId: c });
    expect(inner.calls.refreshSession).toBe(0);
    expect(inner.createRecords.filter((r) => r.token === "jwt-OLD")).toHaveLength(1);
    expect((await memberCounts(f, c)).succeeded).toBe(6);
    expect((await identityState(f)).status).toBe("connected");
  });
});
