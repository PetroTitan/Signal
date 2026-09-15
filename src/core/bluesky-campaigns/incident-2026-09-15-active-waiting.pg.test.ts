import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  actionsFor,
  assertConserved,
  campaignRow,
  createFollowFixture,
  identityState,
  intentsFor,
  makeFollowCampaign,
  makeMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  type FollowFixture,
} from "./test-support/pg-harness";
import { recoverReauthorizedCampaignsForConnectedIdentities } from "@/repositories/bluesky-campaign-repository";
import { dispatchFairly } from "./dispatch-round.server";

/**
 * PRODUCTION, 2026-09-15 (third finding) — identity
 * @webmasterid.bsky.social, campaign cdbb2b76-998c-4cdf-a235-78f629eebc9a.
 *
 * The operator reconnected. Accounts says "Signed in — Signal can act as
 * this account." After the scheduled cron slot:
 *
 *   campaign status:      active
 *   today's run status:   waiting_for_auth
 *   attempted / succeeded: 20 / 18
 *   last successful action 2026-09-15T15:35:55.741492Z
 *
 * and the identity's other active campaign kept an
 * authentication-stopped run too.
 *
 * THE GAP. `recover_bluesky_reauthorized_campaigns` — the sweep the fair
 * round runs before listing — selected only
 * `f.status = 'reauthorization_required'`. A campaign that is `active`
 * with today's run `waiting_for_auth` (the shape a replayed campaign-stop
 * PATCH, a recovery that reactivated the campaign but whose delivery
 * then stopped the run again, or a stale write can leave) is excluded
 * before the run is inspected. The sweep returns nothing, however many
 * deliveries happen.
 *
 * This file is the decisive proof on the shipped migrations and real
 * PostgreSQL, calling the SAME entry point `dispatch-round.server.ts`
 * calls. On unmodified `c91bf90` the sweep recovers nothing and the run
 * stays `waiting_for_auth` (log kept next to the incident document). No
 * follow is performed anywhere.
 */

let f: FollowFixture;
const T0 = "2026-09-15T16:00:00Z";
const DAY = "2026-09-15";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

beforeAll(async () => {
  f = await createFollowFixture("active-waiting");
}, 180_000);
afterAll(async () => { await f?.close(); });
afterEach(async () => {
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'cancelled' where workspace_id = $1 and status <> 'cancelled'`,
    [f.tenant.workspaceId]);
  await f.db.query(
    `update public.bluesky_identity_daily_usage set attempts_made = 0, follows_created = 0 where operator_account_id = $1`,
    [f.tenant.identityId]);
});

/** The exact production shape: connected identity, active campaign, today's run waiting, counters kept, members queued. */
async function productionShape(name: string, members = 40) {
  await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
  const c = await makeFollowCampaign(f, name, { requestedDailyQuota: 300 });
  await makeMembers(f, c, members, name.slice(0, 2));
  // 20 attempted, 18 succeeded, the rest still queued.
  await f.db.query(
    `update public.bluesky_follow_campaign_members m
        set status = 'succeeded', completed_at = now()
      where m.id in (select id from public.bluesky_follow_campaign_members where campaign_id = $1 order by import_sequence limit 18)`, [c]);
  const run = (await f.db.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,300,300,null)`,
    [f.tenant.workspaceId, c, DAY])).rows[0].id;
  await f.db.query(
    `update public.bluesky_follow_campaign_runs
        set status = 'waiting_for_auth', last_error_code = 'reauthorization_required',
            last_error_message = 'Bluesky rejected this identity''s session.',
            attempted_count = 20, succeeded_count = 18, failed_count = 0,
            started_at = '2026-09-15T15:00:00Z', last_chunk_at = '2026-09-15T15:35:55.741492Z'
      where id = $1`, [run]);
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'active', next_run_at = '2026-09-15T15:40:00Z' where id = $1`, [c]);
  return { c, run };
}

const snapshot = async (c: string) => ({
  members: (await f.db.query(`select id, status, attempt_count, next_attempt_at, lease_expires_at from public.bluesky_follow_campaign_members where campaign_id = $1 order by import_sequence`, [c])).rows,
  ledger: (await f.db.query(`select l.* from public.bluesky_campaign_attempt_ledger l join public.bluesky_follow_campaign_members m on m.id = l.member_id where m.campaign_id = $1 order by l.id`, [c])).rows,
  reservations: (await f.db.query(`select * from public.bluesky_campaign_quota_reservations where campaign_id = $1 order by id`, [c])).rows,
  usage: (await f.db.query(`select attempts_made, follows_created from public.bluesky_identity_daily_usage where operator_account_id = $1 and usage_date = $2`, [f.tenant.identityId, DAY])).rows,
});

describe("connected identity + active campaign + today's run waiting_for_auth", () => {
  it("the sweep the fair round runs recovers it: same run id, counters byte-for-byte, queue/ledger/reservations untouched, due now, zero provider calls", async () => {
    const { c, run } = await productionShape("webmasterid-auto-300");
    const sibling = await productionShape("WebmasterID 1-3", 12);
    const id = await identityState(f);
    expect(id.status).toBe("connected");
    const before = await snapshot(c);
    const runBefore = (await runsFor(f, c))[0];

    // The entry point dispatch-round.server.ts calls before listing.
    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, nowIso: T0, db: f.client,
    });
    expect(recovered.map((r) => r.campaignId).sort()).toEqual([c, sibling.c].sort());
    for (const r of recovered) expect(r.runResumed, r.campaignId).toBe(true);

    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("active");
    expect(camp.last_error_code).toBeNull();
    expect(new Date(String(camp.next_run_at)).getTime()).toBeLessThanOrEqual(Date.parse(T0));
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run);
    expect(runs[0].status).toBe("running");
    expect(runs[0].last_error_code).toBeNull();
    expect(runs[0].last_error_message).toBeNull();
    expect(Number(runs[0].attempted_count)).toBe(20);
    expect(Number(runs[0].succeeded_count)).toBe(18);
    expect(runs[0].effective_daily_quota).toBe(runBefore.effective_daily_quota);
    expect(runs[0].started_at).toEqual(runBefore.started_at);
    // Nothing else moved.
    expect(await snapshot(c)).toEqual(before);
    expect((await runsFor(f, sibling.c))[0].status).toBe("running");
    expect((await runsFor(f, sibling.c))[0].id).toBe(sibling.run);

    // Idempotent: a second sweep finds nothing to do.
    expect(await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, nowIso: at(1), db: f.client,
    })).toEqual([]);
    await assertConserved(f, c, expect);
  });

  it("the next fair delivery continues the SAME run: counters advance from 20/18, one unit and one intent per member, no duplicate", async () => {
    const { c, run } = await productionShape("continues");
    const provider = providerDouble({ createRecord: () => ({ status: 200 }) });
    const round = await dispatchFairly({
      db: f.client, nowIso: at(5), fetchImpl: provider.fetchImpl, sleep: async () => undefined, interRequestMs: 0,
      deadlineMs: 600_000, chunkCostMs: 1, settleMarginMs: 0, workspaceId: f.tenant.workspaceId, campaignId: c,
    });
    // Two rounds in one delivery (a 20-member chunk, then the last 2):
    // every served entry is this campaign.
    expect(round.served.length).toBeGreaterThan(0);
    expect(new Set(round.served.map((s) => s.campaignId))).toEqual(new Set([c]));
    expect(provider.calls.refreshSession).toBe(0);
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run);
    expect(Number(runs[0].attempted_count)).toBe(20 + 22);
    expect(Number(runs[0].succeeded_count)).toBe(18 + 22);
    expect((await memberCounts(f, c)).succeeded).toBe(40);
    expect(provider.calls.createRecord).toBe(22);
    expect(new Set(provider.createRecords.map((r) => r.subjectDid)).size).toBe(22);
    expect(await intentsFor(f, c)).toBe(22);
    expect((await actionsFor(f, c)).filter((a) => a.status === "succeeded")).toHaveLength(22);
    await assertConserved(f, c, expect);
  });
});

describe("the sweep never resumes what belongs to the operator", () => {
  it("an operator-paused campaign with a waiting run stays paused; a cancelled campaign stays cancelled; a completed campaign stays completed", async () => {
    const paused = await productionShape("op-paused", 6);
    await f.db.query(`update public.bluesky_follow_campaigns set status = 'paused', paused_at = now(), next_run_at = null where id = $1`, [paused.c]);
    const cancelled = await productionShape("op-cancelled", 6);
    await f.db.query(`update public.bluesky_follow_campaigns set status = 'cancelled', cancelled_at = now() where id = $1`, [cancelled.c]);
    const completed = await productionShape("op-completed", 6);
    await f.db.query(`update public.bluesky_follow_campaigns set status = 'completed', completed_at = now() where id = $1`, [completed.c]);

    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, nowIso: T0, db: f.client,
    });
    expect(recovered).toEqual([]);
    expect((await campaignRow(f, paused.c)).status).toBe("paused");
    expect((await runsFor(f, paused.c))[0].status).toBe("waiting_for_auth");
    expect((await campaignRow(f, cancelled.c)).status).toBe("cancelled");
    expect((await campaignRow(f, completed.c)).status).toBe("completed");
  });

  it("a run stopped for a NON-recoverable reason is not resumed even under an active campaign", async () => {
    const { c } = await productionShape("breaker", 6);
    await f.db.query(
      `update public.bluesky_follow_campaign_runs set status = 'paused', last_error_code = null,
              last_error_message = 'Stopped after 5 consecutive failures.' where campaign_id = $1`, [c]);
    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, nowIso: T0, db: f.client,
    });
    expect(recovered).toEqual([]);
    expect((await runsFor(f, c))[0].status).toBe("paused");
  });

  it("an identity that is NOT connected recovers nothing, whatever the campaign says", async () => {
    const { c } = await productionShape("not-connected", 6);
    await f.db.query(`update public.platform_connections set connection_status = 'reauthorization_required' where id = $1`, [f.connectionId]);
    const recovered = await recoverReauthorizedCampaignsForConnectedIdentities({
      workspaceId: f.tenant.workspaceId, nowIso: T0, db: f.client,
    });
    expect(recovered).toEqual([]);
    expect((await runsFor(f, c))[0].status).toBe("waiting_for_auth");
    await f.db.query(`update public.platform_connections set connection_status = 'connected' where id = $1`, [f.connectionId]);
  });
});

describe("health", () => {
  it("counts connected identity + active campaign + waiting current run; zero after the sweep", async () => {
    const { c } = await productionShape("health", 6);
    const before = await f.db.query<{ n: string }>(`select count(*)::text as n from public.bluesky_recovery_health()`);
    expect(Number(before.rows[0].n)).toBeGreaterThanOrEqual(1);
    const rows = await f.db.query<{ campaign_id: string }>(`select campaign_id from public.bluesky_recovery_health()`);
    expect(rows.rows.map((r) => r.campaign_id)).toContain(c);
    await recoverReauthorizedCampaignsForConnectedIdentities({ workspaceId: f.tenant.workspaceId, nowIso: T0, db: f.client });
    const after = await f.db.query<{ n: string }>(`select count(*)::text as n from public.bluesky_recovery_health()`);
    expect(Number(after.rows[0].n)).toBe(0);
  });
});
