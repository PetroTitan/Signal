import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "./server-harness";

/**
 * Two REAL PostgreSQL sessions contending for the same quota.
 *
 * This is the gate PGlite cannot meet. PGlite is genuine PostgreSQL but
 * runs a single backend, so `select … for update` can never be observed
 * blocking a second session and `skip locked` can never be observed
 * skipping one. Those are exactly the mechanisms the reservation
 * depends on, so proving them needs a server with two backends.
 *
 * Every assertion here is about interleaving, not about SQL syntax —
 * the migration and RLS suites already cover that.
 *
 * No provider call is made anywhere in this file; it is pure database.
 */

let h: PgServerHarness;
let t: ServerTenant;
const TODAY = "2026-09-11";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "two-session");
}, 300_000);

afterAll(async () => {
  await h?.close();
});

async function freshCampaign(
  members: number,
  effectiveQuota: number,
): Promise<{ campaignId: string; runId: string }> {
  const c = await h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status, requested_daily_quota)
     values ($1,$2,$3,'active',100) returning id`,
    [t.workspaceId, t.identityId, `camp-${Math.random().toString(36).slice(2, 8)}`],
  );
  const campaignId = c.rows[0].id;

  const values: string[] = [];
  for (let i = 1; i <= members; i += 1) {
    values.push(`('${t.workspaceId}','${campaignId}','did:plc:m${i}',${i})`);
  }
  await h.admin.query(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence)
     values ${values.join(",")}`,
  );

  const r = await h.admin.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,$4,$5,$6)`,
    [t.workspaceId, campaignId, TODAY, 100, effectiveQuota, null],
  );
  return { campaignId, runId: r.rows[0].id };
}

const reserve = (
  db: Client,
  campaignId: string,
  runId: string,
  opts: { requested?: number; chunk?: number; ceiling?: number; by?: string } = {},
) =>
  db.query<{
    reserved: number;
    reservation_id: string | null;
    reason: string;
    member_id: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId,
      campaignId,
      runId,
      t.identityId,
      TODAY,
      opts.requested ?? 100,
      opts.ceiling ?? 10_000,
      opts.chunk ?? 20,
      300,
      opts.by ?? "worker",
    ],
  );

const granted = (rows: { member_id: string | null }[]) =>
  rows.filter((r) => r.member_id !== null).length;

describe("two backends, one quota", () => {
  it("the second session BLOCKS on the first's row lock", async () => {
    // The premise everything else rests on. If this does not block, the
    // reservation is not serialised and no other assertion means much.
    const { campaignId, runId } = await freshCampaign(50, 50);
    const a = await h.connect();
    const b = await h.connect();

    await a.query("begin");
    await a.query(
      `select * from public.bluesky_follow_campaign_runs where id=$1 for update`,
      [runId],
    );

    let bDone = false;
    const bWork = (async () => {
      await b.query("begin");
      await b.query(
        `select * from public.bluesky_follow_campaign_runs where id=$1 for update`,
        [runId],
      );
      bDone = true;
      await b.query("rollback");
    })();

    await new Promise((r) => setTimeout(r, 400));
    expect(bDone).toBe(false); // genuinely blocked, not merely slow

    await a.query("rollback");
    await bWork;
    expect(bDone).toBe(true);

    await a.end();
    await b.end();
    expect(campaignId).toBeTruthy();
  }, 60_000);

  it("concurrent reservations never exceed the run's quota", async () => {
    const { campaignId, runId } = await freshCampaign(400, 60);
    const sessions = await Promise.all([
      h.connect(),
      h.connect(),
      h.connect(),
      h.connect(),
    ]);

    // Four backends, all reserving at once, repeatedly.
    const results = await Promise.all(
      sessions.map(async (db, i) => {
        let total = 0;
        for (let pass = 0; pass < 5; pass += 1) {
          const r = await reserve(db, campaignId, runId, {
            chunk: 20,
            by: `w${i}`,
          });
          total += granted(r.rows);
        }
        return total;
      }),
    );

    const handedOut = results.reduce((a, b) => a + b, 0);
    // THE assertion: never more than the day allows, across real
    // concurrent sessions.
    expect(handedOut).toBeLessThanOrEqual(60);
    expect(handedOut).toBe(60);

    // And each member was handed to exactly one worker.
    const claimed = await h.admin.query<{ n: string }>(
      `select count(*) n from public.bluesky_follow_campaign_members
        where campaign_id=$1 and status='claimed'`,
      [campaignId],
    );
    expect(Number(claimed.rows[0].n)).toBe(60);

    for (const s of sessions) await s.end();
  }, 120_000);

  it("concurrent reservations never exceed the IDENTITY ceiling", async () => {
    // The ceiling belongs to the Bluesky account, so two campaigns
    // driving one identity must be bounded together.
    const one = await freshCampaign(300, 100);
    const two = await freshCampaign(300, 100);
    const sessions = await Promise.all([h.connect(), h.connect()]);

    const before = await h.admin.query<{ n: string }>(
      `select coalesce(sum(reserved_count),0) n
         from public.bluesky_campaign_quota_reservations
        where workspace_id=$1 and operator_account_id=$2 and usage_date=$3
          and status in ('open','held')`,
      [t.workspaceId, t.identityId, TODAY],
    );
    const already = Number(before.rows[0].n);

    const counts = await Promise.all([
      (async () => {
        let n = 0;
        for (let i = 0; i < 5; i += 1) {
          n += granted(
            (
              await reserve(sessions[0], one.campaignId, one.runId, {
                chunk: 25,
                ceiling: already + 30,
                by: "a",
              })
            ).rows,
          );
        }
        return n;
      })(),
      (async () => {
        let n = 0;
        for (let i = 0; i < 5; i += 1) {
          n += granted(
            (
              await reserve(sessions[1], two.campaignId, two.runId, {
                chunk: 25,
                ceiling: already + 30,
                by: "b",
              })
            ).rows,
          );
        }
        return n;
      })(),
    ]);

    expect(counts[0] + counts[1]).toBeLessThanOrEqual(30);
    for (const s of sessions) await s.end();
  }, 120_000);

  it("settlement is exactly-once under concurrent duplicate settles", async () => {
    const { campaignId, runId } = await freshCampaign(60, 60);
    const a = await h.connect();
    const r = await reserve(a, campaignId, runId, { chunk: 20 });
    const reservationId = r.rows[0].reservation_id!;
    expect(reservationId).toBeTruthy();

    const settle = (db: Client) =>
      db.query<{ settled: boolean; already_settled: boolean }>(
        `select * from public.apply_bluesky_run_outcome(
           $1,$2,$3,$4,$5,$6, 0, null, null, null)`,
        [t.workspaceId, campaignId, runId, t.identityId, TODAY, reservationId],
      );

    // Spend every unit first, the way the worker does — one member at
    // a time, immediately before its mutation.
    for (const row of r.rows.filter((x) => x.member_id)) {
      await a.query(
        `select * from public.consume_bluesky_member_quota($1,$2,$3,null)`,
        [t.workspaceId, reservationId, row.member_id],
      );
    }

    const sessions = await Promise.all([h.connect(), h.connect(), h.connect()]);
    // Three backends settle the SAME reservation simultaneously.
    const outcomes = await Promise.all(sessions.map((s) => settle(s)));
    const settledCount = outcomes.filter((o) => o.rows[0].settled).length;

    expect(settledCount).toBe(1);
    expect(outcomes.filter((o) => o.rows[0].already_settled).length).toBe(2);

    const run = await h.admin.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    // Not 60. Each unit was spent once, and settling three times over
    // folded the ledger once.
    expect(Number(run.rows[0].attempted_count)).toBe(20);

    await a.end();
    for (const s of sessions) await s.end();
    expect(campaignId).toBeTruthy();
  }, 120_000);

  it("a late settle cannot consume a reservation opened after it", async () => {
    // The precise race the hotfix exists for: A settles AFTER B has
    // reserved, and must touch only its own quota.
    const { campaignId, runId } = await freshCampaign(200, 100);
    const a = await h.connect();
    const b = await h.connect();

    const ra = await reserve(a, campaignId, runId, { chunk: 20, by: "A" });
    const aRes = ra.rows[0].reservation_id!;

    // A spends every unit and finishes its members, clearing their
    // leases, WITHOUT settling — the exact window the old lease-derived
    // accounting misread.
    for (const row of ra.rows.filter((x) => x.member_id)) {
      await a.query(
        `select * from public.consume_bluesky_member_quota($1,$2,$3,null)`,
        [t.workspaceId, aRes, row.member_id],
      );
    }
    await h.admin.query(
      `update public.bluesky_follow_campaign_members
          set status='succeeded', lease_expires_at=null, claimed_at=null
        where reservation_id=$1`,
      [aRes],
    );

    const rb = await reserve(b, campaignId, runId, { chunk: 20, by: "B" });
    const bRes = rb.rows[0].reservation_id!;
    expect(bRes).not.toBe(aRes);

    // Now A settles, late.
    await a.query(
      `select * from public.apply_bluesky_run_outcome(
         $1,$2,$3,$4,$5,$6, 0, null, null, null)`,
      [t.workspaceId, campaignId, runId, t.identityId, TODAY, aRes],
    );

    // B's reservation is untouched and still open.
    const bRow = await h.admin.query<{ status: string; reserved_count: number }>(
      `select status, reserved_count
         from public.bluesky_campaign_quota_reservations where id=$1`,
      [bRes],
    );
    expect(bRow.rows[0].status).toBe("open");
    expect(Number(bRow.rows[0].reserved_count)).toBe(20);

    // And the day's books add up: 20 attempted + 20 still reserved.
    const run = await h.admin.query<{
      attempted_count: number;
      reserved_count: number;
    }>(
      `select attempted_count, reserved_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].attempted_count)).toBe(20);
    expect(Number(run.rows[0].reserved_count)).toBe(20);

    await a.end();
    await b.end();
    expect(campaignId).toBeTruthy();
  }, 120_000);

  it("only one backend wins the dispatch lease", async () => {
    const { runId } = await freshCampaign(20, 20);
    const sessions = await Promise.all([
      h.connect(),
      h.connect(),
      h.connect(),
      h.connect(),
    ]);

    const results = await Promise.all(
      sessions.map((db, i) =>
        db.query<{ acquire_bluesky_run_dispatch_lease: boolean }>(
          `select public.acquire_bluesky_run_dispatch_lease($1,$2,$3,$4)`,
          [t.workspaceId, runId, `owner-${i}`, 300],
        ),
      ),
    );
    const winners = results.filter(
      (r) => r.rows[0].acquire_bluesky_run_dispatch_lease === true,
    ).length;

    // This is what makes the consecutive-failure breaker meaningful.
    expect(winners).toBe(1);
    for (const s of sessions) await s.end();
  }, 120_000);

  it("SKIP LOCKED really hands different rows to different backends", async () => {
    const { campaignId, runId } = await freshCampaign(100, 100);
    const sessions = await Promise.all([h.connect(), h.connect(), h.connect()]);

    const batches = await Promise.all(
      sessions.map((db, i) =>
        reserve(db, campaignId, runId, { chunk: 10, by: `s${i}` }),
      ),
    );

    const ids = batches.flatMap((b) =>
      b.rows.filter((r) => r.member_id).map((r) => r.member_id as string),
    );
    // No row handed to two backends.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(30);

    for (const s of sessions) await s.end();
    expect(campaignId).toBeTruthy();
  }, 120_000);
});
